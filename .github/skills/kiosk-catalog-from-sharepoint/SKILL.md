---
name: kiosk-catalog-from-sharepoint
description: Build or refresh the video kiosk catalog (catalogs/universe-on-the-road.json) from the Ignite 2026 booth folders in SharePoint, with titles and descriptions from the GitHub project board draft items. Read-only for SharePoint and GitHub. Use when the user asks to regenerate, refresh, or update the kiosk catalog, or to add booth videos to the kiosk.
---

# Kiosk catalog from SharePoint

This procedure makes `catalogs/universe-on-the-road.json` for the video kiosk.

> **SharePoint and the GitHub project board are read-only.** Never create, change, move,
> rename, upload, or delete anything in SharePoint or on the board. Use only the read
> calls below. Do not run `sync_board.py` or any other script that writes to the board.

## Sources

- **SharePoint:** DevRel site > Content Library > `Ignite 2026 Booth Videos`.
  - Drive ID: `b!dHG736DXYkOLt2ZEBHd7rD_j-Xm6SLtCoDN1ZjEpgDKlJltxj33mR6S9oPmvNrRj`
  - `Ignite 2026 Booth Videos` folder ID: `01B6F5VMP4TSXEJUWIVBG3BTFHRCNHG2IN`
- **Board:** GitHub org project 25729 (`MSFT IGNITE 2026 - Developer Booths`). Each video
  has a draft item. The item title is the video title. The `Description:` section of the
  body is the video description. The body also has `SharePoint ID: <uniqueId>`.
- **Optional metadata:** `/Users/danwahlin/Desktop/test/ignite-2026/.github/skills/booth-video-tracker/video-metadata.json`
  (used only when a video has no board item).
- **Local videos:** `videos/<SharePoint folder name>/` in this project. The kiosk plays
  these files. SharePoint videos cannot stream into the kiosk.

The kiosk shows only these four folders:

| SharePoint folder | Icon (Octicon) |
|---|---|
| `GitHub Advanced Security - Found means fixed` | `shield-check` |
| `GitHub Copilot - Automations, Metrics, Code Review, Cloud Agent` | `sparkles-fill` |
| `GitHub Copilot - Desktop App, CLI, SDK` | `device-desktop` |
| `GitHub Enterprise - Scale AI-powered development with confidence` | `stack` |

The text before ` - ` becomes the folder title. The text after it becomes the description.

## Procedure

1. **List the booth folders (read).** `workiq-fetch`:
   `/drives/{driveId}/items/{igniteFolderId}/children?$select=id,name,webUrl,folder`.
   Keep the `id` and `childCount` of the four folders above.
2. **List each folder (read).** Call `workiq-fetch` one time for each folder (one URL per
   call is more reliable than a batch):
   `/drives/{driveId}/items/{folderId}/children?$select=name,webUrl,file,folder,id,sharepointIds&$top=200`.
   The number of items must equal `childCount`. If an item has `folder`, list it the same
   way; its videos belong to the top-level folder. Large results are saved to a temporary
   file; copy that file into the session folder.
3. **Read the board (read).**
   `gh project item-list 25729 --owner github --format json -L 500 > board.json`.
   Make sure that `totalCount` equals the number of items.
4. **Write `listing.json`** in the session folder. `items` can be the raw Graph `value`
   arrays, or `{ "name", "hash", "uniqueId" }` objects (`hash` is
   `file.hashes.quickXorHash`, `uniqueId` is `sharepointIds.listItemUniqueId`):
   ```json
   {
     "title": "Universe on the Road",
     "subtitle": "Self-Serve Videos",
     "icon": "assets/GitHub_Invertocat_White.svg",
     "iconLight": "assets/GitHub_Invertocat_Black.svg",
     "folders": [
       { "name": "GitHub Advanced Security - Found means fixed", "icon": "shield-check", "items": [] }
     ]
   }
   ```
5. **Make sure that the videos are local.** The user copies the SharePoint folders to
   `videos/`. Do not download or change SharePoint files for this.
6. **Generate:**
   ```bash
   node tools/sharepoint-catalog.js --listing <listing.json> --board <board.json> \
     --metadata /Users/danwahlin/Desktop/test/ignite-2026/.github/skills/booth-video-tracker/video-metadata.json \
     --local videos --out catalogs/universe-on-the-road.json
   ```
   The script matches each SharePoint file to a local file by QuickXorHash (the same
   hash that SharePoint reports), so renamed files still match. It caches local hashes in
   `data/cache/hashes.json`. It shows:
   - `NOTE ... matched by name`: the local copy is different from SharePoint. Ask the
     user to copy the current file.
   - `NOT LOCAL (skipped)`: the video is in SharePoint but not in `videos/`.
   - `NEEDS METADATA`: no board item or metadata. The title comes from the file name and
     the description is empty. Do not invent a description; tell the user.
7. **Validate:** `npm run validate -- catalogs/universe-on-the-road.json`. Then, on the
   settings page, select **Reload**.
