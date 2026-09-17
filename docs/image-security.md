# Runtime image security maintenance

The image keeps Puppeteer and its bundled Chrome paired at the same reviewed version. Refreshing operating-system packages must not silently move that browser pairing or alter collection behavior.

The base stage updates the installed ImageMagick, GnuTLS and MariaDB package families from the configured Debian Bookworm repositories. This includes sibling runtime/development packages inherited from the Puppeteer image. It requires minimum vendor-fixed versions for these advisories:

| Family | Required fixed floor | Vendor advisories |
|---|---|---|
| ImageMagick | `8:6.9.11.60+dfsg-1.6+deb12u12` | [CVE-2026-25971](https://security-tracker.debian.org/tracker/CVE-2026-25971), [CVE-2026-56367](https://security-tracker.debian.org/tracker/CVE-2026-56367) |
| GnuTLS | `3.7.9-2+deb12u7` | [CVE-2026-33845](https://security-tracker.debian.org/tracker/CVE-2026-33845), [CVE-2026-42010](https://security-tracker.debian.org/tracker/CVE-2026-42010) |
| MariaDB client | `1:10.11.18-0+deb12u1` | [CVE-2026-44172](https://security-tracker.debian.org/tracker/CVE-2026-44172), [CVE-2026-49261](https://security-tracker.debian.org/tracker/CVE-2026-49261) |

These are package-version checks, not a claim that every advisory has a reachable exploit in this application. Other scanner findings still require vendor-backport and application-path review. Do not compare only upstream version numbers; Debian security fixes often live in the distribution revision.

CI runs the existing mock/unit tests and driver pairing check, builds the full image, then launches Chrome with Puppeteer inside a disposable container with networking disabled. The smoke test uses only an in-memory static page, overrides the application entrypoint, and receives no runtime data, credentials or provider configuration. It must not perform collection, provider sign-in, OTP pairing or record mutation.

After publication, check the exact immutable image's package inventory and vulnerability report before deployment. Keep the previous image ID and existing runtime data/configuration for rollback. A distro refresh does not require database or application-record migration. Review new vendor fixes and whether this targeted package step can be retired when the upstream base supplies equivalent fixes.
