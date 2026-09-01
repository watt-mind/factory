export { GenericCell } from "./base/generic-cell.mjs";
export { SiteCell } from "./editorial/site-cell.mjs";
export { ArticleCell } from "./editorial/article-cell.mjs";
export { CellRouter, defaultRouter } from "./router.mjs";

export default {
  async fetch(request, env) {
    const { defaultRouter } = await import("./router.mjs");
    return defaultRouter.handle(request, env);
  },
};
