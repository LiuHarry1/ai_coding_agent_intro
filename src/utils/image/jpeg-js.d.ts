declare module 'jpeg-js' {
  interface ImageData {
    data: Buffer
    width: number
    height: number
  }

  interface DecodeOptions {
    colorTransform?: boolean
    useTArray?: false
    formatAsRGBA?: boolean
    tolerantDecoding?: boolean
    maxResolutionInMP?: number
    maxMemoryUsageInMB?: number
  }

  export function decode(
    jpegData: Buffer | Uint8Array,
    options?: DecodeOptions,
  ): ImageData

  export function encode(imageData: ImageData, quality?: number): ImageData
}
