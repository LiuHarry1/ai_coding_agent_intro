/**
 * Load an authenticated image URL into a blob: object URL.
 * Used for /sessions/.../uploads/... and /sessions/.../browser/... under SSO.
 */
import { useEffect, useState } from 'react'
import { apiUrl, withAuth } from '../lib/api/_http.js'

export function useAuthedImage(path) {
  const [src, setSrc] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!path) {
      setSrc(null)
      setFailed(false)
      return undefined
    }

    // data: / blob: need no auth fetch
    if (
      path.startsWith('data:') ||
      path.startsWith('blob:') ||
      path.startsWith('http://') ||
      path.startsWith('https://')
    ) {
      setSrc(path)
      setFailed(false)
      return undefined
    }

    let revoked = false
    let objectUrl = null

    fetch(apiUrl(path), withAuth())
      .then(res => (res.ok ? res.blob() : Promise.reject(new Error(res.status))))
      .then(blob => {
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
        setFailed(false)
      })
      .catch(() => {
        if (!revoked) setFailed(true)
      })

    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path])

  return { src, failed }
}
