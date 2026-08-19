/** Compare two lstat identities (dev/ino), with Windows 0/0 handling. */
function isZero(value: number | bigint): boolean {
  return value === 0 || value === 0n
}

function sameStatValue(
  left: number | bigint,
  right: number | bigint,
): boolean {
  return typeof left === typeof right ? left === right : BigInt(left) === BigInt(right)
}

function isStatValueProvablyDifferent(
  left: number | bigint,
  right: number | bigint,
  platform: NodeJS.Platform,
): boolean {
  if (sameStatValue(left, right)) {
    return false
  }
  return platform !== 'win32' || (!isZero(left) && !isZero(right))
}

export function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    !isStatValueProvablyDifferent(left.dev, right.dev, platform) &&
    !isStatValueProvablyDifferent(left.ino, right.ino, platform)
  )
}
