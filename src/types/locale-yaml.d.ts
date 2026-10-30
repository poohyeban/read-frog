declare module "*.yml" {
  interface LocaleTree {
    [key: string]: string | LocaleTree
  }
  const value: LocaleTree
  export default value
}
