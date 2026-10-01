# Third-party notices

VoiceComment 2.0 bundles the following library inside the distributed `main.js`. The
library is included **unmodified**; its source, license and the one-line build
step that concatenates it are all in this repository, so it can be inspected,
replaced or rebuilt freely.

| Library | Version | License | Source | Used for |
|---|---|---|---|---|
| lamejs | 1.2.1 | LGPL-3.0 | https://github.com/zhuker/lamejs | MP3 encoding in the browser |

`src/lame.min.js` in this repository is the unmodified file published on npm as
`lamejs@1.2.1`. `build.ps1` concatenates it with `src/audiohtml.js` to
produce `main.js`:

```powershell
# main.js = src/lame.min.js + "\n" + src/audiohtml.js
```

To rebuild with a different version of lamejs, replace `src/lame.min.js` and run the
build script — no other change is required.

lamejs is a JavaScript port of the LAME MP3 encoder (LGPL). The full text of the
LGPL-3.0 is in [LICENSE](LICENSE).
