/** Files imported `with { type: "text" }`, which Bun inlines as strings, also in a compiled binary. */
declare module "*.py" {
  const text: string;
  export default text;
}
