# Video kiosk

A self-service video kiosk for touch screens. Visitors pick a folder in a 3D carousel, pick
a video from a list, and watch it in full screen. When a video ends, the kiosk goes back to
the list at the same place.

![The kiosk home screen: a 3D carousel of folder cards](docs/images/home.jpg)

- Node.js (Express) with plain HTML, CSS, and JavaScript. No build step.
- Themes: **Dark**, **Light**, **GitHub Dark**, and **GitHub Light**.
- Closed captions from `.vtt` files, with a **CC On/Off** button in the player.
- Touch, mouse, and keyboard: tap or click any folder card, swipe or drag the carousel, or use the arrow keys.
- Works offline. Fonts, icons, and videos are local.

## Quick start

Requires Node.js 20 or later. Optional: [ffmpeg](https://ffmpeg.org/) for thumbnails and
video lengths (`brew install ffmpeg` or `winget install ffmpeg`).

1. Put your videos in `videos/`, one subfolder for each kiosk folder (the video files are
   not in this repository).
2. Install and start:
   ```bash
   npm install
   npm start
   ```
   The settings page opens at `http://127.0.0.1:3000/`. For a different port, use
   `PORT=3001 npm start` (macOS) or `$env:PORT=3001; npm start` (PowerShell). Use
   `npm start -- --no-open` to not open a browser.
3. On the settings page, pick a catalog JSON file or a folder, a theme, and the kiosk
   behavior (idle reset time, attract mode, captions default, caption size).
4. Select **Launch kiosk**. It opens in full screen. **Esc** exits full screen only; a
   **Full screen** button then shows in the upper right. To return to the settings, select
   the gear on the home screen, press and hold the logo or the title for 3 seconds, or press
   **Ctrl+Alt+S**.

![The settings page: videos source, theme, and kiosk behavior](docs/images/settings.jpg)

Settings are saved in `data/settings.json`. The browser also remembers the theme, so a
reload shows it at once.

## Using the kiosk

| Video list | Player |
|---|---|
| ![A folder's video list with thumbnails, titles, and descriptions](docs/images/video-list.jpg) | ![A video playing full screen with captions and controls](docs/images/player.jpg) |

- **Home:** tap any folder card to open it. Swipe or use the arrows and dots to turn the carousel.
  The gear in the top-right corner opens the settings.
- **Video list:** tap a video to play it. **Back** or **Home** returns to the carousel.
- **Player:** tap the video to show the controls, then tap to pause or play. The back arrow (top-left
  corner) is always visible; it shows **Back** when the video is paused. **CC** turns captions on or off; the choice carries to the next
  video. When a video ends, the list returns at the same place, with a check on that video.
- **Idle:** after the idle time, the kiosk returns to the start screen and resets captions and
  watched checks. It never stops a video that is playing. With attract mode on, the carousel
  turns slowly when nobody uses the kiosk.
- **Keyboard:** arrow keys turn the carousel, **Enter** opens or plays, **Backspace** goes back,
  and **Space** pauses.
- **macOS:** in full screen, the menu bar shows when the pointer moves to the top edge. This is
  normal macOS behavior, and the page stays in full screen. The kiosk hides the pointer after
  3 seconds.

## Start a browser in kiosk mode

Open `http://localhost:3000/#kiosk` to start the kiosk without the settings page. Start
the server first. The kiosk flags work only if the browser is not already open, so these
commands use a separate profile folder.

**macOS**

```bash
# Google Chrome
open -na "Google Chrome" --args --kiosk --user-data-dir=/tmp/kiosk-chrome http://localhost:3000/#kiosk
# Microsoft Edge
open -na "Microsoft Edge" --args --kiosk --user-data-dir=/tmp/kiosk-edge http://localhost:3000/#kiosk
```

**Windows (PowerShell)**

```powershell
# Google Chrome
Start-Process chrome -ArgumentList '--kiosk','--user-data-dir=C:\kiosk\chrome','http://localhost:3000/#kiosk'
# Microsoft Edge
Start-Process msedge -ArgumentList '--kiosk','--edge-kiosk-type=fullscreen','--no-first-run','--user-data-dir=C:\kiosk\edge','http://localhost:3000/#kiosk'
```

In browser kiosk mode, select the gear on the home screen (or hold the logo for 3 seconds) to open the settings. To close the browser, press
**Cmd+Q** (macOS) or **Alt+F4** (Windows).

## Catalog JSON

A catalog lists the folders and videos. Schema: [`schema/kiosk-catalog.schema.json`](schema/kiosk-catalog.schema.json).

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
| `iconLight` | No | Icon for the light themes (for example, a black logo when `icon` is white). |
| `folders[].title`, `description` | Yes | `description` can be empty. |
| `folders[].icon` | No | Octicon name or image. Default: `file-directory`. Use the name without the size (`rocket`, not `rocket-24`). |
| `videos[].title`, `description`, `path` | Yes | `path` is a file path or an `http(s)` URL. |
| `videos[].captions` | No | A `.vtt` file. |
| `videos[].thumbnail`, `duration` | No | If you omit them, the server makes them with ffmpeg. |

Relative paths start from the folder that contains the catalog. Validate a catalog with:

```bash
npm run validate -- catalogs/universe-on-the-road.json
```

Errors stop the kiosk from using a catalog. Warnings do not; for example, the kiosk hides a
video whose file is not found.

## Folder mode

Pick a folder instead of a JSON file. Folder mode uses `videos/` by default, and you can
pick any folder inside it (not outside it). Each subfolder becomes a kiosk folder. The name
`GitHub Copilot - Desktop App, CLI, SDK` becomes the title `GitHub Copilot` and the
description `Desktop App, CLI, SDK`. A `.vtt` file with the same name as a video adds
captions, and an optional `<video name>.json` file can set `title` and `description`. Videos
directly in the picked folder become one kiosk folder.

Without a `.json` file, the title comes from the file name: `copilot-cli-fleet.mp4` becomes
`Copilot CLI Fleet`. For question and quiz videos, the words before `question` are sort
prefixes and are removed: `github-gh-t-question-dependabot.mp4` becomes `Question: Dependabot`.

Select **Download catalog JSON** on the settings page to get a catalog that you can edit.

## Security

The server listens on `127.0.0.1` by default. The settings API accepts requests only from
the same computer, and it checks the `Host` header to block DNS rebinding. The media routes
serve only files that the loaded catalog names. If you set `HOST=0.0.0.0` to show the kiosk
on another device, the settings page still works only on the server computer.

## Project structure

```
server.js                    Express server and API
lib/                         Catalog validation, folder mode, ffmpeg media, settings, QuickXorHash
public/                      Settings page and kiosk (HTML, CSS, JavaScript modules)
schema/                      Catalog JSON schema
tools/validate.js            Catalog validation CLI
tools/sharepoint-catalog.js  Builds a catalog from a SharePoint listing and the board
catalogs/                    Catalogs and logo assets
videos/                      Your video files (not in Git)
docs/images/                 README screenshots
```

The GitHub Invertocat files in `catalogs/assets/` come from the
[GitHub brand toolkit](https://brand.github.com/foundations/logo). Show the logo in one
solid color (white on dark, black on light), with no effects.
