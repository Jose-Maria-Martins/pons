// wrangler.jsonc bundles *.png as binary modules.
declare module "*.png" {
  const bytes: ArrayBuffer;
  export default bytes;
}
