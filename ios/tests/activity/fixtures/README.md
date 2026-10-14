# Activity file fixtures

`make_fixtures.py` regenerates every file here.

- `gb_*.json` are test vectors from Gadgetbridge's own test tree (commit `d4bd8367`): captured device bytes copied as data, or inputs rebuilt byte for byte where the Gadgetbridge test builds them in memory, with the values those tests assert. Each file names its source in `source` and `ref`. They come from [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge) and stay under its license, AGPL-3.0-or-later. They are test data only and are not part of the app.
- `synthetic.json` is built from the layouts in `docs/ACTIVITY.md` and is covered by this repository's MIT license.
