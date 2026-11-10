# Video kiosk

A self-service video kiosk for touch screens. Visitors pick a folder in a 3D carousel,
pick a video from a list, and watch it in full screen. When the video ends, the kiosk goes
back to the list at the same place.

- Node.js server (Express) and plain HTML, CSS, and JavaScript. No build step.
- Four themes: **Dark**, **Light**, **GitHub Dark**, and **GitHub Light**.
- Closed captions from WebVTT (`.vtt`) files, with a **CC On/Off** button in the player.
- Thumbnails and video lengths from `ffmpeg` and `ffprobe` (optional).
- Works offline: the fonts, icons, and videos are local.

## Start

Requires Node.js 20 or later.

```bash
npm install
npm start
```

The server starts on `http://127.0.0.1:3000/` and opens the settings page.
Use `PORT=3001 npm start` for a different port, or `npm start -- --no-open` to not open
a browser.

1. **Videos:** select **JSON file** and pick a catalog, or select **Folder** and pick a
   folder of videos. The page validates the source and shows errors and warnings.
2. **Theme:** pick a theme. The settings page changes to show it.
3. **Kiosk behavior:** set the idle time before the kiosk returns to the start screen,
   attract mode (the carousel turns when nobody uses the kiosk), and the default for
   captions.
4. Select **Launch kiosk**. The kiosk opens in full screen. Press **Esc** to exit full
   screen and return to the settings page.

The settings are saved in `data/settings.json`, so they stay after a restart. The browser
also remembers the last theme on that machine, so a reload shows the correct theme at
once, before the settings load.

### Start a browser in kiosk mode

To start the kiosk without the settings page, open `http://localhost:3000/#kiosk`, for
example with Chrome in kiosk mode:

```bash
open -a "Google Chrome" --args --kiosk --autoplay-policy=no-user-gesture-required http://localhost:3000/#kiosk
```

## Catalog JSON

The schema is in [`schema/kiosk-catalog.schema.json`](schema/kiosk-catalog.schema.json).

```json
{
  "$schema": "../schema/kiosk-catalog.schema.json",
  "title": "Universe on the Road",
  "subtitle": "Self-Serve Videos",
  "icon": "assets/GitHub_Invertocat_White.svg",
  "iconLight": "assets/GitHub_Invertocat_Black.svg",
  "folders": [
    {
      "title": "GitHub Copilot",
      "description": "Desktop App, CLI, SDK",
      "icon": "device-desktop",
      "videos": [
        {
          "title": "GitHub Copilot app: Computer Use",
          "description": "A short demo of Computer Use in the GitHub Copilot app.",
          "path": "../videos/GitHub Copilot - Desktop App, CLI, SDK/computer-use.mp4",
          "captions": "../videos/GitHub Copilot - Desktop App, CLI, SDK/computer-use.vtt"
        }
      ]
    }
  ]
}
```

| Property | Required | Notes |
|---|---|---|
| `title` | Yes | Main heading. |
| `subtitle` | No | Line below the title. |
| `icon` | Yes | A [Primer Octicon](https://primer.style/octicons) name, or a path or URL to an image. |
| `iconLight` | No | The icon for the Light and GitHub Light themes, for example a black logo when `icon` is a white logo. |
| `folders[].title`, `description` | Yes | Shown on the folder card. `description` can be empty. |
| `folders[].icon` | No | Octicon name or image. Default: `file-directory`. |
| `videos[].title`, `description`, `path` | Yes | `path` is a file path or an `http(s)` URL. |
| `videos[].captions` | No | A `.vtt` file. |
| `videos[].thumbnail` | No | An image. If you omit it, the server makes one with `ffmpeg`. |
| `videos[].duration` | No | Seconds. If you omit it, the server reads it with `ffprobe`. |

Relative paths start from the folder that contains the catalog file.

Validate a catalog from the command line:

```bash
npm run validate -- catalogs/universe-on-the-road.json
```

Errors (for example, a missing required property) stop the kiosk from using the
catalog. Warnings (for example, a video file that is not found) do not: the kiosk hides
those videos.

## Folder mode

When you pick a folder, each subfolder becomes a kiosk folder, and each video file in it
becomes a video. A subfolder named `GitHub Copilot - Desktop App, CLI, SDK` gets the title
`GitHub Copilot` and the description `Desktop App, CLI, SDK`. A `.vtt` file with the same
name as a video gives captions. An optional `<video name>.json` file next to a video can set
its `title` and `description`. Select **Download catalog JSON** on the settings page to get
a catalog that you can edit.

## Catalog from SharePoint

`catalogs/universe-on-the-road.json` comes from the Ignite 2026 booth folders in SharePoint
and the GitHub project board. The procedure is in
[`.github/skills/kiosk-catalog-from-sharepoint/SKILL.md`](.github/skills/kiosk-catalog-from-sharepoint/SKILL.md).
SharePoint and the board are read-only for this procedure.

## Security

The server listens on `127.0.0.1` by default. The settings API can list folders on the
computer, so it accepts requests only from the same computer (it also checks the `Host`
header to block DNS rebinding). The media routes serve only the files that the loaded
catalog names. If you set `HOST=0.0.0.0` to show the kiosk on a different device, the
settings page still works only on the server computer.

## Project structure

```
server.js                  Express server and API
lib/catalog.js             Schema validation, file checks, path resolution
lib/scan.js                Folder mode
lib/media.js               ffprobe durations and ffmpeg thumbnails (cached in data/cache)
lib/settings.js            Settings and themes
lib/quickxorhash.js        SharePoint QuickXorHash, to match local files to SharePoint files
schema/                    Catalog JSON schema
public/                    Settings page and kiosk (HTML, CSS, JavaScript modules)
tools/validate.js          Catalog validation CLI
tools/sharepoint-catalog.js  Builds a catalog from a SharePoint listing and the board
catalogs/                  Catalog files
videos/                    Local video files
```

## Logo

`catalogs/assets/GitHub_Invertocat_White.svg` and `GitHub_Invertocat_Black.svg` are the
official GitHub Invertocat files from the [GitHub brand toolkit](https://brand.github.com/foundations/logo).
The brand rules: show the logo in one solid color (white on dark, black on light), with no
shadows, gradients, or other effects. The kiosk shows it as is.
