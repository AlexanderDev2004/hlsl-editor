// Alchemy stack: builds apps/web with its own Vite + Foldkit plugin and
// serves the output from Cloudflare Workers static assets.
// Validated statically (tsc). Live deploy needs `alchemy login` and a
// Cloudflare account; the custom domain additionally needs the zone
// alexanderar.com in the account (see README).

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

export const Website = Cloudflare.Website.Foldkit("HlslEditor", {
  rootDir: "apps/web",
  // Custom domain (enable after the zone exists in the Cloudflare account):
  // domain: "hlsleditor.alexanderar.com",
});

export default Alchemy.Stack(
  "HlslEditor",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Website;
    return { url: site.url };
  }),
);
