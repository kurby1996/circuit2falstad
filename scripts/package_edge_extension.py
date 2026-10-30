"""Package the shipped helper as a clearly named Edge extension folder and ZIP."""
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "static" / "browser-helper"
DESTINATION = ROOT / "edge-extension"
FILES = (
    "manifest.json", "background.js", "bridge.js", "workflow.js",
    "popup.html", "popup.js", "README.md",
)


def build() -> None:
    # Only package reviewed extension assets; never copy local settings or outputs.
    for name in FILES:
        if not (SOURCE / name).is_file():
            raise FileNotFoundError(SOURCE / name)
    DESTINATION.mkdir(exist_ok=True)
    for name in FILES:
        shutil.copyfile(SOURCE / name, DESTINATION / name)
    for archive, folder in (
        (ROOT / "edge-extension.zip", "edge-extension"),
        (ROOT / "static" / "browser-helper.zip", "browser-helper"),
    ):
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
            for name in FILES:
                entry = zipfile.ZipInfo(f"{folder}/{name}", date_time=(2020, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = 0o100644 << 16
                package.writestr(entry, (SOURCE / name).read_bytes())
    print("Created edge-extension/, edge-extension.zip and static/browser-helper.zip")


if __name__ == "__main__":
    build()
