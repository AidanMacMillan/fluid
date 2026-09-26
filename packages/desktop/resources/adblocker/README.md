# Ad and tracker filter snapshots

`ads.json.gz` bundles Ghostery's `adsLists` preset and redirect/scriptlet
resources, including original filter text, source URLs, and notices. It excludes
EasyPrivacy and the separate uBlock privacy and annoyance lists.

`trackers.json.gz` bundles EasyPrivacy and uBlock's privacy list, the additional
subscriptions in Ghostery's `adsAndTrackingLists` preset. The two switches select
ads, trackers, both, or neither; tracker blocking defaults off. When both are on,
rules are merged so filter exceptions work across subscriptions. Site exceptions
bypass both types of blocking.

Refresh from `packages/desktop`:

```bash
node scripts/update-adblocker.mjs
```

Fluid uses these snapshots when no compatible disk caches exist, then refreshes
enabled filter groups daily. Failed updates retain the previous engine; the cache stores rules,
not browsing history.

## Sources and licenses

- [Ghostery adblocker assets](https://github.com/ghostery/adblocker/tree/master/packages/adblocker/assets)
- [EasyList](https://easylist.to/pages/licence.html)
- [Peter Lowe's list](https://pgl.yoyo.org/adservers/)
- [uBlock Origin filters](https://github.com/uBlockOrigin/uAssets)
- [uBlock Origin resources](https://github.com/gorhill/uBlock)
