/**
 * The page-side half of the browser tools, injected via `Runtime.evaluate`.
 *
 * It exists for one reason: console output and fetch/XHR traffic are *events*,
 * and neither backend has an event channel — the `BrowserBackend` contract is
 * request/response CDP only. So the page buffers what happened and the tool
 * layer drains it on demand, instead of enabling `Console.*` / `Network.*`.
 *
 * Everything else the tools do (snapshot, click, type, fill) goes through
 * Playwright against the same tab, so nothing here needs to know about the
 * accessibility tree or how to hit a control.
 *
 * Deliberately plain DOM JavaScript with no build step: the extension backend
 * can only ship CDP commands, so anything not expressible as "evaluate this
 * string in the page" would have to be written twice. Keep it that way.
 *
 * No template literals below: the source is embedded with String.raw, which
 * would interpolate `${`.
 */

export const PAGE_SCRIPT_VERSION = 11

export const PAGE_SCRIPT = String.raw`
(function () {
  var VERSION = 11;
  if (window.__agentBrowser && window.__agentBrowser.version === VERSION) {
    return 'already-installed';
  }

  function clip(s, max) {
    if (s.length <= max) return s;
    return s.slice(0, max) + '\u2026';
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
    consoleLogs: consoleLogs,
    networkRequests: networkRequests,
    sinceReport: sinceReport
  };
  return 'installed';
})()
`
