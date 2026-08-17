/**
 * The page-side half of the browser tools, injected via `Runtime.evaluate`.
 *
 * Deliberately plain DOM JavaScript with no build step and no Playwright
 * dependency: the phase-2 extension backend can only ship CDP commands, so
 * anything that isn't expressible as "evaluate this string in the page" would
 * have to be written twice. Keep it that way.
 *
 * It installs `window.__agentBrowser` with these entry points:
 *   snapshot(opts)                  -> an aria-tree the model can read
 *   resolveRef(ref, role, name)     -> viewport coordinates for a ref, with a
 *                                      staleness check against what the model
 *                                      believed it was clicking
 *
 * Refs survive across snapshots (a WeakMap keyed by the element), so a ref the
 * model captured two turns ago still works as long as the element is alive and
 * still means the same thing.
 *
 * No template literals below: the source is embedded with String.raw, which
 * would interpolate `${`.
 */

export const SNAPSHOT_SCRIPT_VERSION = 10

export const SNAPSHOT_SCRIPT = String.raw`
(function () {
  var VERSION = 10;
  if (window.__agentBrowser && window.__agentBrowser.version === VERSION) {
    return 'already-installed';
  }

  var refToEl = new Map();
  var elToRef = new WeakMap();
  var refMeta = new Map();
  var counter = 0;

  var ROLE_BY_TAG = {
    A: 'link', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox',
    IMG: 'img', NAV: 'navigation', MAIN: 'main', HEADER: 'banner',
    FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form',
    TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader',
    UL: 'list', OL: 'list', LI: 'listitem', OPTION: 'option',
    DIALOG: 'dialog', SUMMARY: 'button', PROGRESS: 'progressbar',
    IFRAME: 'iframe', VIDEO: 'video', AUDIO: 'audio', CANVAS: 'canvas',
    SVG: 'img', HR: 'separator', BLOCKQUOTE: 'blockquote', CODE: 'code',
    PRE: 'code'
  };

  var ROLE_BY_INPUT_TYPE = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    file: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider',
    search: 'searchbox', number: 'spinbutton', hidden: null,
    text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox',
    password: 'textbox', date: 'textbox', 'datetime-local': 'textbox',
    month: 'textbox', week: 'textbox', time: 'textbox', color: 'textbox'
  };

  // OpenClaw snapshot-roles.ts, three buckets. Interactive always get a ref;
  // content is emitted when named; structural is skipped in compact mode.
  var INTERACTIVE = {
    link: 1, button: 1, textbox: 1, searchbox: 1, checkbox: 1, radio: 1,
    combobox: 1, listbox: 1, option: 1, slider: 1, spinbutton: 1, tab: 1,
    menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, 'switch': 1,
    treeitem: 1
  };

  var CONTENT = {
    article: 1, cell: 1, columnheader: 1, gridcell: 1, heading: 1,
    listitem: 1, main: 1, navigation: 1, region: 1, rowheader: 1,
    img: 1, alert: 1, status: 1, dialog: 1, alertdialog: 1, form: 1,
    table: 1, list: 1, row: 1, tablist: 1, progressbar: 1, banner: 1,
    contentinfo: 1, complementary: 1
  };

  var STRUCTURAL = {
    application: 1, directory: 1, document: 1, generic: 1, grid: 1,
    group: 1, ignored: 1, list: 1, menu: 1, menubar: 1, none: 1,
    presentation: 1, row: 1, rowgroup: 1, table: 1, tablist: 1,
    toolbar: 1, tree: 1, treegrid: 1
  };

  // ARIA name-from-contents. generic is not on this list — its label is a
  // text: child, not a quoted name that swallows the subtree.
  var NAME_FROM_CONTENT = {
    link: 1, button: 1, checkbox: 1, radio: 1, option: 1, tab: 1,
    menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, 'switch': 1,
    treeitem: 1, heading: 1
  };

  // ARIA name-from-contents also includes these, but Playwright's AI distiller
  // drops a name that is already covered by the children it will emit
  // (removeRedundantNames). Quoting the concatenated subtree here would
  // duplicate every child and blow the char budget on any dense list or table.
  var WRAPPER_NAME_ROLES = {
    listitem: 1, cell: 1, gridcell: 1, columnheader: 1, rowheader: 1, row: 1
  };

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1,
    TEMPLATE: 1, BASE: 1
  };

  function squash(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function clip(s, max) {
    if (s.length <= max) return s;
    return s.slice(0, max) + '\u2026';
  }

  function styleOf(el) {
    try {
      return el.ownerDocument.defaultView.getComputedStyle(el);
    } catch (e) {
      return null;
    }
  }

  function isVisible(el) {
    if (el.nodeType !== 1) return false;
    var st = styleOf(el);
    if (!st) return false;
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (st.opacity !== '' && parseFloat(st.opacity) === 0) return false;
    if (el.hasAttribute('hidden')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    var r = el.getBoundingClientRect();
    // Zero-size wrappers still matter when their children are painted, so this
    // only rejects elements that are themselves empty AND childless.
    if (r.width === 0 && r.height === 0 && el.children.length === 0) return false;
    return true;
  }

  function explicitRole(el) {
    var r = el.getAttribute && el.getAttribute('role');
    if (!r) return null;
    return squash(r).split(' ')[0] || null;
  }

  function roleOf(el) {
    var explicit = explicitRole(el);
    if (explicit) return explicit;
    var tag = el.tagName;
    if (tag === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      return Object.prototype.hasOwnProperty.call(ROLE_BY_INPUT_TYPE, t)
        ? ROLE_BY_INPUT_TYPE[t]
        : 'textbox';
    }
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (el.isContentEditable) return 'textbox';
    return ROLE_BY_TAG[tag] || null;
  }

  function labelText(el) {
    var doc = el.ownerDocument;
    var out = [];
    if (el.id) {
      var forLabels = doc.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]');
      for (var i = 0; i < forLabels.length; i++) out.push(forLabels[i].textContent);
    }
    var wrapper = el.closest ? el.closest('label') : null;
    if (wrapper) out.push(wrapper.textContent);
    return squash(out.join(' '));
  }

  function nameOf(el, role) {
    // Playwright removeRedundantNames: once children will be in the tree,
    // a wrapper accname (aria-label included) just repeats them and blows
    // the budget so later chrome never gets emitted.
    if (role && WRAPPER_NAME_ROLES[role] && hasElementChild(el)) {
      return squash((el.getAttribute && el.getAttribute('title')) || '');
    }

    var labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var parts = [];
      var ids = labelledBy.split(/\s+/);
      for (var i = 0; i < ids.length; i++) {
        var named = el.ownerDocument.getElementById(ids[i]);
        if (named) parts.push(named.textContent);
      }
      var joined = squash(parts.join(' '));
      if (joined) return joined;
    }

    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && squash(aria)) return squash(aria);

    var tag = el.tagName;

    if (tag === 'IMG' || tag === 'AREA') {
      var alt = squash(el.getAttribute('alt') || '');
      if (alt) return alt;
    }

    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      var lbl = labelText(el);
      if (lbl) return lbl;
      var ph = squash(el.getAttribute('placeholder') || '');
      if (ph) return ph;
      if (tag === 'INPUT') {
        var ty = (el.getAttribute('type') || '').toLowerCase();
        if (ty === 'submit' || ty === 'button' || ty === 'reset') {
          var v = squash(el.value || '');
          if (v) return v;
        }
      }
      var nm = squash(el.getAttribute('name') || '');
      if (nm) return nm;
    }

    if (tag === 'SVG' || tag === 'svg') {
      var svgTitle = el.querySelector && el.querySelector('title');
      if (svgTitle) return squash(svgTitle.textContent);
    }

    if (role && NAME_FROM_CONTENT[role]) {
      var text = squash(el.textContent || '');
      if (text && text.length <= 120) return text;
    }

    var t = squash((el.getAttribute && el.getAttribute('title')) || '');
    if (t) return t;

    return '';
  }

  function hasPointerCursor(el) {
    var st = styleOf(el);
    return !!(st && st.cursor === 'pointer');
  }

  // cursor inherits. An inner div with cursor:pointer is usually just sitting
  // inside the real click target, not a second one. Only the outermost
  // pointer node counts, unless the node has its own activation hook.
  function isPointerRoot(el) {
    if (!hasPointerCursor(el)) return false;
    var p = el.parentElement;
    if (!p || p.tagName === 'BODY' || p.tagName === 'HTML') return true;
    return !hasPointerCursor(p);
  }

  function hasElementChild(el) {
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      if (!SKIP_TAGS[kids[i].tagName]) return true;
    }
    return false;
  }

  function isNamelessImage(el) {
    var tag = el.tagName;
    if (tag !== 'IMG' && tag !== 'SVG' && tag !== 'svg') return false;
    if (squash(el.getAttribute('alt') || '')) return false;
    if (squash(el.getAttribute('aria-label') || '')) return false;
    var title = el.querySelector && el.querySelector('title');
    if (title && squash(title.textContent)) return false;
    return true;
  }

  // A cursor:pointer node that is not a semantic control — the CSS-only
  // widget pattern. Real button/link/input keep their own refs.
  // Nameless img/svg icons are not standalone widgets: they sit next to a
  // chip or label and would otherwise make pointerKids === 2, blocking
  // the grouping parent from getting the ref (Playwright drops nameless
  // images unless they are the click-target root).
  function isCssPointerWidget(el) {
    if (!isPointerRoot(el)) return false;
    if (isNamelessImage(el)) return false;
    var role = roleOf(el);
    if (role && INTERACTIVE[role]) return false;
    if (el.hasAttribute('onclick')) return false;
    if (el.tabIndex >= 0) return false;
    return true;
  }

  function hasInteractiveDescendant(el) {
    var role = roleOf(el);
    if (role && INTERACTIVE[role]) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.tabIndex >= 0 && el.tagName !== 'BODY') return true;
    if (isCssPointerWidget(el)) return true;
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      if (SKIP_TAGS[kids[i].tagName]) continue;
      if (hasInteractiveDescendant(kids[i])) return true;
    }
    return false;
  }

  // Phrasing / tabular containers wrap sentences and cells, not composite
  // widgets. Promoting them would steal the ref from an inline pointer span.
  var LABEL_GROUP_SKIP = {
    P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    LI: 1, TD: 1, TH: 1, LABEL: 1, FIGCAPTION: 1,
    BLOCKQUOTE: 1, PRE: 1, CODE: 1, DT: 1, DD: 1
  };

  // Playwright keeps unnamed generics that group more than one child
  // ("logical grouping still makes sense, even if it is not ref-able").
  // When that group is a CSS-pointer leaf plus a non-interactive label,
  // the clickable surface is the group — otherwise the pointer child
  // takes the only ref and the label is an unclickable text: sibling.
  //
  // Only do this when the pointer child has no real name of its own
  // (icon, count chip). An already-labeled pointer span inside a
  // sentence is the control; the wrapper is not.
  function isPointerLabelGroup(el) {
    if (el.tagName === 'BODY' || el.tagName === 'HTML') return false;
    if (LABEL_GROUP_SKIP[el.tagName]) return false;
    var role = roleOf(el);
    if (role && INTERACTIVE[role]) return false;

    var pointerKid = null;
    var pointerKids = 0;
    var iconKid = null;
    var hasSiblingLabel = false;
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (SKIP_TAGS[k.tagName]) continue;
      if (!isVisible(k)) continue;
      if (isCssPointerWidget(k)) {
        pointerKids += 1;
        if (pointerKids > 1) return false;
        pointerKid = k;
      } else if (isPointerRoot(k) && isNamelessImage(k)) {
        iconKid = k;
      } else if (hasInteractiveDescendant(k)) {
        return false;
      } else if (
        squash(k.textContent || '') ||
        k.tagName === 'IMG' || k.tagName === 'SVG' || k.tagName === 'svg'
      ) {
        hasSiblingLabel = true;
      }
    }
    if (pointerKids === 0 && iconKid) {
      pointerKid = iconKid;
      pointerKids = 1;
    }
    if (pointerKids !== 1 || !pointerKid) return false;
    if (!hasSiblingLabel && !ownText(el)) return false;

    var chipName = squash(pointerKid.textContent || '');
    if (chipName.length > 2) return false;
    var groupText = squash(el.textContent || '');
    if (!chipName) return groupText.length > 0;
    var remainder = squash(groupText.split(chipName).join(' '));
    return remainder.length > chipName.length;
  }

  function pointerLabelGroupAncestor(el) {
    var p = el.parentElement;
    var hops = 0;
    while (p && hops < 4) {
      if (isPointerLabelGroup(p) || isOverlayWidget(p)) return true;
      p = p.parentElement;
      hops++;
    }
    return false;
  }

  function isOverlayChrome(el) {
    var st = styleOf(el);
    if (!st) return false;
    return st.position === 'fixed' || st.position === 'sticky';
  }

  function hasSemanticControl(el) {
    var role = roleOf(el);
    if (role && INTERACTIVE[role]) return true;
    var tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      return true;
    }
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      if (SKIP_TAGS[kids[i].tagName]) continue;
      if (hasSemanticControl(kids[i])) return true;
    }
    return false;
  }

  // React/Vue docks often have no cursor:pointer and no ARIA role — the
  // listener is on a position:fixed host. A short-labeled overlay with no
  // link/button inside is that widget; a fixed header is not (it has links).
  function isOverlayWidget(el) {
    if (el.tagName === 'BODY' || el.tagName === 'HTML' || el.tagName === 'IFRAME') return false;
    if (!isOverlayChrome(el)) return false;
    var t = squash(el.textContent || '');
    if (!t || t.length > 80) return false;
    if (hasSemanticControl(el)) return false;
    return true;
  }

  function isClickable(el, role) {
    if (role && INTERACTIVE[role]) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.tabIndex >= 0 && el.tagName !== 'BODY') return true;
    if (isPointerLabelGroup(el)) return true;
    if (isOverlayWidget(el)) return true;
    if (isPointerRoot(el) && !pointerLabelGroupAncestor(el)) return true;
    return false;
  }

  function textDigest(el) {
    return clip(squash(el.textContent || ''), 40);
  }

  /**
   * Playwright AI snapshots keep the real role. A pointer-cursor div is
   * generic with a ref and [cursor=pointer], not a forged button.
   * html/body stay out of the tree — they would otherwise eat a ref.
   */
  function snapshotRole(el) {
    var role = roleOf(el);
    if (role === 'presentation' || role === 'none') return null;
    if (role) return role;
    if (el.tagName === 'BODY' || el.tagName === 'HTML') return null;
    return 'generic';
  }

  /**
   * Labels pick up counts and timestamps constantly, so exact equality would
   * churn refs on every render. A row that a framework recycled for a different
   * record shares nothing with its old label, which is the case worth catching.
   */
  function nameMatches(a, b) {
    a = squash(a || '').toLowerCase();
    b = squash(b || '').toLowerCase();
    if (!a || !b) return a === b;
    return a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
  }

  function elementFor(ref) {
    var held = refToEl.get(ref);
    if (!held) return null;
    return typeof WeakRef === 'function' ? held.deref() : held;
  }

  /**
   * A ref identifies an element *and what it meant*, not just the DOM node.
   * When an element's role or name changes it gets a new ref and the old one
   * starts failing, so a ref the model captured before the change can never
   * silently act on the thing that replaced it.
   */
  function assignRef(el, role, name) {
    var digest = textDigest(el);
    var existing = elToRef.get(el);
    if (existing) {
      var meta = refMeta.get(existing);
      if (meta && meta.role === role && nameMatches(meta.name, name)) {
        // Unnamed generics (the pointer-div case) are distinguished by digest
        // so a recycled node with different text cannot keep the old ref.
        if (name || nameMatches(meta.digest, digest)) return existing;
      }
    }
    counter += 1;
    var ref = 'e' + counter;
    elToRef.set(el, ref);
    refToEl.set(ref, typeof WeakRef === 'function' ? new WeakRef(el) : el);
    refMeta.set(ref, { role: role, name: name, digest: digest });
    return ref;
  }

  function stateSuffix(el, role) {
    var bits = [];
    if (role === 'heading') {
      var lvl = el.getAttribute('aria-level') || (/^H([1-6])$/.test(el.tagName) ? el.tagName[1] : '');
      if (lvl) bits.push('level=' + lvl);
    }
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      var checked = el.getAttribute('aria-checked');
      if (checked === null && 'checked' in el) checked = el.checked ? 'true' : 'false';
      if (checked) bits.push('checked=' + checked);
    }
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    var expanded = el.getAttribute('aria-expanded');
    if (expanded) bits.push('expanded=' + expanded);
    var selected = el.getAttribute('aria-selected');
    if (selected) bits.push('selected=' + selected);
    if ((role === 'textbox' || role === 'searchbox') && 'value' in el && el.value) {
      bits.push('value=' + JSON.stringify(clip(String(el.value), 60)));
    }
    return bits.length ? ' [' + bits.join('] [') + ']' : '';
  }

  function ownText(el) {
    // Text that belongs to this element rather than to a child we will visit.
    var out = [];
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) out.push(n.nodeValue);
    }
    return squash(out.join(' '));
  }

  function firstElementChild(el) {
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      if (!SKIP_TAGS[kids[i].tagName]) return kids[i];
    }
    return null;
  }

  function isCollapsibleWrapper(el, role, clickable) {
    if (role !== 'generic' || clickable) return false;
    if (el.shadowRoot) return false;
    if (ownText(el)) return false;
    var n = 0;
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      if (SKIP_TAGS[kids[i].tagName]) continue;
      n += 1;
      if (n > 1) return false;
    }
    return n === 1;
  }

  function snapshot(opts) {
    opts = opts || {};
    var maxNodes = opts.maxNodes || 1500;
    var maxChars = opts.maxChars || 20000;
    var compact = !!opts.compact;
    var lines = [];
    var emitted = 0;
    var chars = 0;
    var truncated = false;
    var chromePass = false;
    var chromeBudget = 2500;

    function emit(depth, text) {
      var cap = chromePass ? maxChars + chromeBudget : maxChars;
      var nodeCap = chromePass ? maxNodes + 40 : maxNodes;
      if (emitted >= nodeCap || chars >= cap) {
        truncated = true;
        return false;
      }
      var line = new Array(depth + 1).join('  ') + '- ' + text;
      if (emitted > 0 && chars + line.length + 1 > cap) {
        truncated = true;
        return false;
      }
      emitted += 1;
      chars += line.length + 1;
      lines.push(line);
      return true;
    }

    function walk(el, depth, framePrefix, inPointer, ancestorName) {
      var cap = chromePass ? maxChars + chromeBudget : maxChars;
      var nodeCap = chromePass ? maxNodes + 40 : maxNodes;
      if (emitted >= nodeCap || chars >= cap) { truncated = true; return; }
      if (!el || el.nodeType !== 1) return;
      if (SKIP_TAGS[el.tagName]) return;
      if (!isVisible(el)) return;

      var role = snapshotRole(el);
      var pointer = hasPointerCursor(el);
      var clickable = isClickable(el, role);
      var childDepth = depth;
      var described = false;
      var name = '';
      var nextPointer = inPointer || (clickable && pointer);
      var nextAncestor = ancestorName;

      if (el.tagName === 'IFRAME') {
        name = nameOf(el, role);
        var innerDoc = null;
        try { innerDoc = el.contentDocument; } catch (e) { innerDoc = null; }
        var frameId = el.id ? clip(el.id, 40) : '';
        var host = '';
        try {
          if (el.src) host = (new URL(el.src)).host;
        } catch (e2) { host = ''; }
        var label = 'iframe';
        if (name) label += ' "' + clip(name, 80) + '"';
        else if (frameId) label += ' "' + frameId + '"';
        if (!innerDoc) {
          // Cross-origin: the parent frame genuinely cannot see inside. The
          // model needs to know the gap exists rather than assume an empty page.
          var gap = label + ' [cross-origin, contents not accessible]';
          if (host) gap += ' /url: ' + host;
          emit(depth, gap);
          return;
        }
        emit(depth, label);
        var body = innerDoc.body;
        if (body) walk(body, depth + 1, framePrefix, false, '');
        return;
      }

      if (isCollapsibleWrapper(el, role, clickable)) {
        var only = firstElementChild(el);
        if (only) walk(only, depth, framePrefix, nextPointer, ancestorName);
        return;
      }

      var emitThis = false;
      if (role) {
        if (clickable || CONTENT[role]) emitThis = true;
        if (compact && STRUCTURAL[role] && !clickable) emitThis = false;
      }

      if (emitThis) {
        name = nameOf(el, role);
        if (role === 'generic' && name && squash(name) === squash(ancestorName)) {
          emitThis = false;
        }
      }

      if (emitThis) {
        var text = role + (name ? ' "' + clip(name, 120) + '"' : '');
        if (clickable) {
          text += ' [ref=' + framePrefix + assignRef(el, role, name) + ']';
          // Playwright only marks the pointer-event root. A label-group
          // parent may not itself have cursor:pointer, but it is the target.
          if (!inPointer && (pointer || isPointerLabelGroup(el) || isOverlayWidget(el))) {
            text += ' [cursor=pointer]';
          }
        }
        text += stateSuffix(el, role);
        if (role === 'link' && el.getAttribute('href')) {
          text += ' /url: ' + clip(el.getAttribute('href'), 100);
        }
        if (!emit(depth, text)) return;
        described = true;
        childDepth = depth + 1;
        if (name) nextAncestor = name;
      }

      // Leaf-ish actionables already carry their label as the accessible name;
      // recursing would repeat it as a text node.
      if (described && role && INTERACTIVE[role] && role !== 'listitem') {
        return;
      }

      var own = ownText(el);
      // Playwright drops a lone text child that is already the accessible name.
      if (own && squash(own) !== squash(name)) {
        emit(childDepth, 'text: ' + clip(own, 200));
      }

      if (el.shadowRoot) {
        var sr = el.shadowRoot.children;
        for (var s = 0; s < sr.length; s++) walk(sr[s], childDepth, framePrefix, nextPointer, nextAncestor);
      }

      var kids = el.children;
      for (var i = 0; i < kids.length; i++) walk(kids[i], childDepth, framePrefix, nextPointer, nextAncestor);
    }

    function inOverlayChrome(el) {
      if (isOverlayChrome(el)) return true;
      var p = el.parentElement;
      var hops = 0;
      while (p && hops < 12) {
        if (isOverlayChrome(p)) return true;
        p = p.parentElement;
        hops++;
      }
      return false;
    }

    // Fixed/sticky widgets (chat docks, cookie banners) are usually last in
    // the DOM. A char budget that walks document order would drop them on
    // any long page. Playwright keeps interactables; we append any overlay
    // clickable that did not already get a ref.
    function collectOverlayClickables(root) {
      var out = [];
      var seen = [];
      function already(el) {
        for (var i = 0; i < seen.length; i++) if (seen[i] === el) return true;
        return false;
      }
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (SKIP_TAGS[el.tagName]) continue;
        if (!isVisible(el)) continue;
        if (!inOverlayChrome(el)) continue;
        var role = snapshotRole(el);
        if (!isClickable(el, role)) continue;
        if (elToRef.get(el)) continue;
        var target = el;
        var p = el.parentElement;
        if (p && (isPointerLabelGroup(p) || isOverlayWidget(p)) && !elToRef.get(p)) target = p;
        if (already(target)) continue;
        seen.push(target);
        out.push(target);
        if (out.length >= 20) break;
      }
      return out;
    }

    var root = document.body;
    if (opts.selector) {
      try {
        root = document.querySelector(opts.selector);
      } catch (e) {
        return {
          url: location.href,
          title: document.title,
          text: 'Invalid selector: ' + String(opts.selector),
          nodes: 0,
          truncated: false
        };
      }
      if (!root) {
        return {
          url: location.href,
          title: document.title,
          text: 'No element matched selector: ' + String(opts.selector),
          nodes: 0,
          truncated: false
        };
      }
    }
    if (root) walk(root, 0, '', false, '');

    if (root && !opts.selector) {
      var overlay = collectOverlayClickables(root);
      if (overlay.length) {
        chromePass = true;
        for (var c = 0; c < overlay.length; c++) {
          walk(overlay[c], 0, '', false, '');
        }
      }
    }

    return {
      url: location.href,
      title: document.title,
      text: lines.join('\n'),
      nodes: emitted,
      truncated: truncated
    };
  }

  function frameOffset(el) {
    // Rects are frame-local; walk up the same-origin frame chain so callers get
    // coordinates usable with top-level Input.dispatchMouseEvent.
    var dx = 0, dy = 0;
    var win = el.ownerDocument.defaultView;
    while (win && win !== window.top) {
      var fe = null;
      try { fe = win.frameElement; } catch (e) { break; }
      if (!fe) break;
      var r = fe.getBoundingClientRect();
      dx += r.left;
      dy += r.top;
      win = fe.ownerDocument.defaultView;
    }
    return { dx: dx, dy: dy };
  }

  /**
   * When a ref goes stale the model's whole snapshot is usually one render
   * behind, not wrong about intent. Rather than bounce it for a fresh snapshot
   * (a full round trip that often lands on the same drift), relocate the element
   * by the role+name the ref used to mean. This is deliberately conservative:
   * it only accepts a match when role agrees and the name overlaps, so it can
   * never silently retarget a recycled row to a different record.
   */
  function findByRoleName(expectedRole, expectedName, expectedDigest) {
    if (!expectedName && !expectedRole && !expectedDigest) return null;
    var best = null, bestScore = 0, scanned = 0;
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (scanned > 6000) break; // one-shot recovery, not a hot path
      var el = all[i];
      if (SKIP_TAGS[el.tagName]) continue;
      var role = snapshotRole(el);
      if (!role) continue;
      scanned++;
      if (expectedRole && role !== expectedRole) continue;
      // We only mint refs for clickable generics, so recovery must too —
      // otherwise a wrapper div that merely contains the label wins.
      if (role === 'generic' && !isClickable(el, role)) continue;
      if (!isVisible(el)) continue;
      var name = nameOf(el, role);
      var score = expectedRole && role === expectedRole ? 40 : 0;
      if (expectedName) {
        var a = squash(name || '').toLowerCase();
        var b = squash(expectedName || '').toLowerCase();
        if (!a) continue;
        if (a === b) score += 60;
        else if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) score += 30;
        else continue;
      } else if (expectedDigest) {
        if (!nameMatches(textDigest(el), expectedDigest)) continue;
        score += 60;
      }
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    // Require both signals when both were known; a lone role match is too weak.
    var threshold = expectedRole && (expectedName || expectedDigest) ? 70 : 60;
    return bestScore >= threshold ? best : null;
  }

  function previewNode(el) {
    if (!el || el.nodeType !== 1) return String(el);
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = (el.getAttribute && el.getAttribute('class')) || '';
    if (cls) s += '.' + squash(cls).split(' ').slice(0, 2).join('.');
    var t = squash(el.textContent || '');
    if (t) s += ' "' + clip(t, 40) + '"';
    return s;
  }

  /**
   * Name the thing sitting on top of a click target so the model can act on it
   * ("close the dialog") instead of retrying the same blocked click. Walks up
   * from the intercepting node because the visible blocker is usually a child of
   * the element that carries the modal/overlay semantics.
   */
  function classifyBlocker(node) {
    var n = node, hops = 0;
    while (n && n.nodeType === 1 && hops < 12) {
      if (n.tagName === 'IFRAME') return 'iframe';
      var role = n.getAttribute && n.getAttribute('role');
      if (role === 'dialog' || role === 'alertdialog' ||
          (n.getAttribute && n.getAttribute('aria-modal') === 'true')) return 'modal';
      var st = styleOf(n);
      if (st && (st.position === 'fixed' || st.position === 'sticky')) {
        var r = n.getBoundingClientRect();
        var vh = n.ownerDocument.documentElement.clientHeight || 0;
        if (r.top <= 4 && r.height < vh * 0.5) return 'fixed-header';
        return 'overlay';
      }
      n = n.parentElement;
      hops++;
    }
    return 'sibling';
  }

  function occlusionAt(el) {
    var doc = el.ownerDocument;
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var vw = doc.documentElement.clientWidth || 0;
    var vh = doc.documentElement.clientHeight || 0;
    // Off-screen after scrolling means the point test is meaningless; the caller
    // already handles zero-size, and a real user would just see nothing there.
    if (cx < 0 || cy < 0 || (vw && cx > vw) || (vh && cy > vh)) return null;
    var top = null;
    try { top = doc.elementFromPoint(cx, cy); } catch (e) { return null; }
    if (!top) return null;
    if (top === el || el.contains(top) || top.contains(el)) return null;
    return { blockingType: classifyBlocker(top), interceptedBy: previewNode(top) };
  }

  function geometryOf(ref, el, role, name, recoveredFrom) {
    try {
      if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(true);
      else el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (e) { /* detached-ish elements; the rect check below decides */ }

    var rect = el.getBoundingClientRect();
    var off = frameOffset(el);
    var x = rect.left + off.dx + rect.width / 2;
    var y = rect.top + off.dy + rect.height / 2;

    if (rect.width === 0 || rect.height === 0) {
      return {
        error: 'not-visible',
        message: 'Element ' + ref + ' (' + role + ' "' + clip(name, 60) + '") has zero size and cannot be clicked.'
      };
    }

    var result = {
      ok: true, ref: ref, role: role, name: name,
      x: x, y: y,
      // Page-relative twin of x/y, for CDP screenshot clips which are not
      // viewport-relative.
      pageX: x + (window.scrollX || 0), pageY: y + (window.scrollY || 0),
      width: rect.width, height: rect.height,
      tag: el.tagName.toLowerCase(),
      isEditable: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
    };
    if (recoveredFrom) { result.recovered = true; result.recoveredFrom = recoveredFrom; }
    var occ = occlusionAt(el);
    if (occ) { result.blockingType = occ.blockingType; result.interceptedBy = occ.interceptedBy; }
    return result;
  }

  function recover(ref, expectedRole, expectedName, expectedDigest) {
    var found = findByRoleName(expectedRole, expectedName, expectedDigest);
    if (!found) return null;
    var role = snapshotRole(found) || '';
    var name = nameOf(found, role);
    var newRef = assignRef(found, role, name);
    return geometryOf(newRef, found, role, name || textDigest(found), ref);
  }

  function resolveRef(ref, expectedRole, expectedName) {
    // Default the expectation to whatever this ref meant in the snapshot the
    // model actually read. That beats asking the model to restate the element,
    // which only ever checks whether it can paraphrase its own input.
    var meta = refMeta.get(ref) || {};
    if (expectedRole === undefined || expectedRole === null) expectedRole = meta.role;
    if (expectedName === undefined || expectedName === null) expectedName = meta.name;

    var el = elementFor(ref);
    if (!el || !el.isConnected) {
      var recovered = recover(ref, expectedRole, expectedName, meta.digest);
      if (recovered) return recovered;
      var missing = !el ? 'No element for ref ' + ref + '.' :
        'Element ' + ref + ' was removed from the page.';
      return { error: !el ? 'unknown' : 'detached', message: missing + ' Take a fresh snapshot.' };
    }

    var role = snapshotRole(el) || '';
    var name = nameOf(el, role);
    var digest = textDigest(el);

    if (expectedRole || expectedName || meta.digest) {
      var roleOk = !expectedRole || expectedRole === role;
      var nameOk = !expectedName || nameMatches(expectedName, name);
      // Unnamed generics: the digest is the identity. Skip it when a real
      // accessible name is in play (buttons, links) so a count in the label
      // can still rotate via nameMatches.
      var digestOk = expectedName || !meta.digest || nameMatches(meta.digest, digest);
      if (!roleOk || !nameOk || !digestOk) {
        // The node still exists but now means something else — the framework
        // reused it. Try to find where the original meaning moved to before
        // giving up, same as the detached path.
        var moved = recover(ref, expectedRole, expectedName, meta.digest);
        if (moved) return moved;
        return {
          error: 'stale',
          message: 'Ref ' + ref + ' was ' + (expectedRole || '?') + ' "' +
            clip(expectedName || meta.digest || '', 80) + '" but now points at ' + role + ' "' +
            clip(name || digest, 80) + '". The page changed; take a fresh snapshot and use the new ref.'
        };
      }
    }

    return geometryOf(ref, el, role, name || digest, null);
  }

  /**
   * Resolves once the document has loaded and the DOM has stopped changing for
   * quietMs. SPAs report readyState 'complete' long before they have painted
   * anything, so the mutation quiet period is what actually makes snapshots
   * taken right after a navigation useful.
   */
  function waitStable(quietMs, timeoutMs, minMs) {
    quietMs = quietMs || 300;
    timeoutMs = timeoutMs || 5000;
    minMs = minMs || 0;
    return new Promise(function (resolve) {
      var start = Date.now();
      var timer = null;
      var observer = null;
      var done = false;

      function finish(reason) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (observer) observer.disconnect();
        resolve({ reason: reason, waitedMs: Date.now() - start, readyState: document.readyState });
      }

      function arm() {
        if (timer) clearTimeout(timer);
        if (Date.now() - start > timeoutMs) return finish('timeout');
        timer = setTimeout(function () {
          var left = minMs - (Date.now() - start);
          if (left > 0) {
            timer = setTimeout(function () { finish('quiet'); }, left);
            return;
          }
          finish('quiet');
        }, quietMs);
      }

      function begin() {
        observer = new MutationObserver(arm);
        // Attributes are deliberately excluded: CSS-animation libraries mutate
        // style/class every frame, so watching them means the page never goes
        // "quiet" and every post-nav snapshot pays the full timeout.
        observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: false, characterData: true
        });
        arm();
        setTimeout(function () { finish('timeout'); }, timeoutMs);
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', begin, { once: true });
        setTimeout(function () { finish('timeout'); }, timeoutMs);
      } else {
        begin();
      }
    });
  }

  function setValue(ref, value) {
    var r = resolveRef(ref);
    if (r.error) return r;
    var el = elementFor(ref);
    // A field the app computes rejects the write on save, so report it here
    // rather than let a value the page never accepted look like a success.
    if (el.readOnly) return { error: 'readonly', message: 'Ref ' + ref + ' is readonly; the app computes it from other fields.' };
    if (el.disabled) return { error: 'disabled', message: 'Ref ' + ref + ' is disabled.' };
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      // React and friends install a value setter on the instance; going through
      // the prototype setter is what makes their onChange actually fire.
      var proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, value);
      else el.value = value;
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else {
      return { error: 'not-editable', message: 'Ref ' + ref + ' is a ' + el.tagName.toLowerCase() + ', not a text field.' };
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, role: r.role, name: r.name };
  }

  function readValue(ref) {
    var r = resolveRef(ref);
    if (r.error) return r;
    var el = elementFor(ref);
    var inner = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : el.querySelector('input, textarea');
    var target = inner || el;
    return {
      ok: true,
      value: target.isContentEditable ? (target.innerText || '').trim() : (target.value || ''),
      readOnly: !!target.readOnly,
      disabled: !!target.disabled
    };
  }

  function setChecked(ref, checked) {
    var r = resolveRef(ref);
    if (r.error) return r;
    var el = elementFor(ref);
    var role = el.getAttribute('role');
    var native = el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');
    if (!native && role !== 'checkbox' && role !== 'radio' && role !== 'switch') {
      return { error: 'not-toggle', message: 'Ref ' + ref + ' is a ' + el.tagName.toLowerCase() + ', not a checkbox or radio.' };
    }
    var state = function () {
      return native ? !!el.checked : el.getAttribute('aria-checked') === 'true';
    };
    // Click rather than assign .checked: a custom toggle keeps its state in the
    // app, and a radio can only be cleared by checking a sibling.
    if (state() !== checked) el.click();
    return { ok: true, role: r.role, name: r.name, checked: state() };
  }

  function selectOption(ref, values) {
    var r = resolveRef(ref);
    if (r.error) return r;
    var el = elementFor(ref);
    if (el.tagName !== 'SELECT') {
      return { error: 'not-select', message: 'Ref ' + ref + ' is a ' + el.tagName.toLowerCase() + ', not a <select>.' };
    }
    var chosen = [];
    for (var i = 0; i < el.options.length; i++) {
      var opt = el.options[i];
      var match = values.indexOf(opt.value) !== -1 || values.indexOf(squash(opt.textContent)) !== -1;
      opt.selected = match;
      if (match) chosen.push(squash(opt.textContent) || opt.value);
    }
    if (!chosen.length) {
      var available = [];
      for (var j = 0; j < el.options.length && j < 30; j++) {
        available.push(squash(el.options[j].textContent) || el.options[j].value);
      }
      return { error: 'no-match', message: 'No option matched. Available: ' + available.join(', ') };
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: chosen };
  }

  // Console capture lives here rather than on CDP's Runtime.consoleAPICalled
  // because the tool layer has no event channel: both backends can only issue
  // commands, so the page buffers and we drain it on demand.
  var logs = [];
  var MAX_LOGS = 500;

  function describeArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }

  function pushLog(level, parts) {
    logs.push({ level: level, text: clip(parts.join(' '), 2000), at: Date.now() });
    if (logs.length > MAX_LOGS) logs.shift();
  }

  var levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (var li = 0; li < levels.length; li++) {
    (function (level) {
      var original = console[level];
      if (typeof original !== 'function') return;
      console[level] = function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(describeArg(arguments[i]));
        pushLog(level, parts);
        return original.apply(console, arguments);
      };
    })(levels[li]);
  }

  window.addEventListener('error', function (ev) {
    var where = ev.filename ? ' (' + ev.filename + ':' + ev.lineno + ':' + ev.colno + ')' : '';
    pushLog('error', [(ev.error && ev.error.stack) || ev.message || 'Uncaught error', where]);
  });

  window.addEventListener('unhandledrejection', function (ev) {
    pushLog('error', ['Unhandled promise rejection:', describeArg(ev.reason)]);
  });

  function consoleLogs(opts) {
    opts = opts || {};
    var out = logs;
    if (opts.level) {
      out = out.filter(function (l) { return l.level === opts.level; });
    }
    if (opts.since) {
      out = out.filter(function (l) { return l.at > opts.since; });
    }
    var limit = opts.limit || 100;
    return { entries: out.slice(-limit), total: out.length, now: Date.now() };
  }

  // Network capture, same bargain as the console hooks above: no event channel,
  // so the page records and we drain on demand. Patching fetch/XHR sees exactly
  // what the app asked for, which is the question being debugged ("did the call
  // go out, and what came back?"). It does not see document navigation or
  // subresources — CDP's Network domain would, but that needs events.
  var netlog = [];
  var MAX_NET = 200;
  var netSeq = 0;

  function absolute(u) {
    try { return new URL(u, location.href).href; } catch (e) { return String(u); }
  }

  function startNet(kind, method, url) {
    var rec = {
      id: ++netSeq,
      kind: kind,
      method: (method || 'GET').toUpperCase(),
      url: absolute(url),
      status: 0,
      statusText: '',
      ok: false,
      pending: true,
      failed: false,
      error: '',
      startedAt: Date.now(),
      durationMs: 0
    };
    netlog.push(rec);
    if (netlog.length > MAX_NET) netlog.shift();
    return rec;
  }

  function finishNet(rec, status, statusText) {
    rec.pending = false;
    rec.status = status;
    rec.statusText = statusText || '';
    rec.ok = status >= 200 && status < 400;
    rec.durationMs = Date.now() - rec.startedAt;
  }

  function failNet(rec, message) {
    rec.pending = false;
    rec.failed = true;
    rec.error = clip(message || 'request failed', 300);
    rec.durationMs = Date.now() - rec.startedAt;
  }

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      var method = 'GET';
      try {
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.href;
        else if (input && input.url) { url = input.url; method = input.method || method; }
        if (init && init.method) method = init.method;
      } catch (e) { /* never let instrumentation break the call */ }
      var rec = startNet('fetch', method, url);
      var out;
      try {
        out = origFetch.apply(this, arguments);
      } catch (e) {
        failNet(rec, String((e && e.message) || e));
        throw e;
      }
      return out.then(
        function (res) {
          finishNet(rec, res.status, res.statusText);
          return res;
        },
        function (err) {
          // A rejected fetch never got a response: DNS, offline, CORS, abort.
          failNet(rec, String((err && err.message) || err));
          throw err;
        }
      );
    };
  }

  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function') {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try { this.__agentNet = { method: method, url: url }; } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var meta = null;
      try { meta = this.__agentNet; } catch (e) {}
      if (meta) {
        var self = this;
        var rec = startNet('xhr', meta.method, meta.url);
        this.addEventListener('loadend', function () {
          // status 0 after loadend means it never reached a server.
          if (!self.status) failNet(rec, 'request failed (no response)');
          else finishNet(rec, self.status, self.statusText);
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  function networkRequests(opts) {
    opts = opts || {};
    var out = netlog;
    if (opts.failedOnly) {
      out = out.filter(function (r) { return r.failed || r.status >= 400; });
    }
    if (opts.urlContains) {
      var needle = String(opts.urlContains).toLowerCase();
      out = out.filter(function (r) { return r.url.toLowerCase().indexOf(needle) !== -1; });
    }
    if (opts.since) {
      out = out.filter(function (r) { return r.startedAt > opts.since; });
    }
    var limit = opts.limit || 50;
    return { entries: out.slice(-limit), total: out.length, now: Date.now() };
  }

  // What every action reports back: errors and broken requests since the last
  // action, in one round trip rather than two.
  function sinceReport(since) {
    var errs = consoleLogs({ level: 'error', since: since, limit: 20 });
    var net = networkRequests({ failedOnly: true, since: since, limit: 20 });
    return { logs: errs.entries, network: net.entries, now: Date.now() };
  }

  window.__agentBrowser = {
    version: VERSION,
    snapshot: snapshot,
    resolveRef: resolveRef,
    setValue: setValue,
    readValue: readValue,
    setChecked: setChecked,
    selectOption: selectOption,
    consoleLogs: consoleLogs,
    networkRequests: networkRequests,
    sinceReport: sinceReport,
    waitStable: waitStable
  };
  return 'installed';
})()
`
