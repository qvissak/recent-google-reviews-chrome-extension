# Chrome Web Store: what to enter

Upload: `../recent-reviews-1.0.1.zip` (Package tab). Version 1.0.1 narrows the site access (see the host permission justification); do not use any older zip.

## Store listing tab

| Field | Value |
|---|---|
| Title / Summary | Already filled from the package. Nothing to do. |
| Description | Paste the contents of `description.txt` |
| Category | Lifestyle (or Shopping if Lifestyle is not offered) |
| Language | English (United States) |
| Store icon | `store-icon-128.png` (128x128, 16px transparent margin) |
| Screenshots | Five ready in `screenshots/` (all 640x400, 24-bit PNG): 01-result, 02-breakdown, 03-reviews-list, 04-calculating, 05-settings. Upload in that order. |
| Small promo tile (440x280) | `promo-tile-440x280.png` |
| Homepage / Support URL | Optional. A GitHub repo or an email contact works. |
| Mature content | No |

### Screenshots
Captured from the real extension running on a real Google Search page (Krasi, Boston), at native resolution and cropped below Google's header. In 03-reviews-list the reviewers' names, photos and text are blurred, since they are other people's. 05-settings is the real popup on a plain background.
No Maps screenshot yet: Maps needs its own capture on a normal (non-automated) browser.

## Privacy practices tab

**Single purpose description**
> Shows the average rating of a place's recent Google reviews (for example the last 1, 3 or 6 months) next to Google's all-time rating on Google Search and Google Maps place pages.

**Permission justification: storage**
> Used only to save the user's own settings so they persist between visits and sync across their Chrome profile: whether the badge is turned on for Google Search and for Google Maps, the longest time window the badge shows, and which window the reviews list opens on. It stores four small values. It never stores reviews, place names, search queries or any browsing data.

**Host permission justification** (the content script runs only on https://www.google.com, .co.uk, .ca, .com.au, .co.nz and .ie, and only on their /search and /maps pages)
> The extension's single purpose is to add a recent-reviews average next to a place's rating on Google Search and Google Maps. So its content script runs only on those two pages: the /search and /maps paths of Google's www site, over https, for the six Google domains where it is supported (google.com, google.co.uk, google.ca, google.com.au, google.co.nz, google.ie). It does not run on any other Google product (Gmail, Docs, Drive, Accounts and so on) or on any other site. On those pages it reads the place's rating and the reviews shown on the page, in the user's own browser, to calculate the average, and draws a small badge and a reviews list. Nothing it reads leaves the browser. The extension requests no separate host permissions.

**Are you using remote code?** No. All code is packaged in the extension: no remote scripts, no eval, no network requests.

**Data usage: what user data do you collect?** None of the listed categories. (The extension reads the rating and reviews on the Google page you are viewing, but that stays in your browser: nothing is sent, stored off-device or shared.)

**Certifications** (tick all three; they are true):
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes unrelated to the item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** host `privacy-policy.md` somewhere public (a GitHub repo page, a public Gist, GitHub Pages or a public Notion page all work) and paste that link. Add your contact email where marked.

## Test instructions for reviewers (if asked)
> No account or setup needed. Open Google Search and look up any local business with reviews, for example "krasi boston". The extension adds a small strip with 1M / 3M / 6M averages next to the rating after a few seconds. Click it to see the reviews that were counted. The toolbar popup has the settings (Search / Maps toggles, longest window, default window).

## Distribution tab
- Visibility: Unlisted first if you want to test the real install by link, then switch to Public.
- Regions: all. Pricing: free.
- Then Submit for review (a deliberate click for you to make).
