declare module "pdf-parse" {
  interface PdfData {
    numpages?: number;
    text?: string;
  }
  function pdfParse(buffer: Buffer): Promise<PdfData>;
  export default pdfParse;
}
