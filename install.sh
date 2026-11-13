#!/bin/sh
# cc-remote installer: downloads a release binary for this machine, checks it against the
# release's SHA256SUMS, installs it into ~/.local/share/cc-remote/versions/<version>/ and points
# ~/.local/bin/cc-remote at it with an atomic rename (running sessions keep their own copy), then
# runs `cc-remote setup`. It never uses sudo and never edits shell startup files.
#
#   curl -fsSL https://raw.githubusercontent.com/specialpointcentral/cc-remote/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --host central --yes     (arguments go to cc-remote setup)
#
# --no-setup skips setup. CC_REMOTE_VERSION=0.3.1 installs that release instead of the latest.
# CC_REMOTE_RELEASE_BASE replaces https://github.com/<repo>/releases, for tests only.
#
# Everything is inside main(), called on the last line, so a truncated download runs nothing.
set -eu

REPO=specialpointcentral/cc-remote

say() { printf '%s\n' "$*"; }
die() { printf 'cc-remote install: %s\n' "$*" >&2; exit 1; }

# Downloads $1 to the file $2.
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "needs curl or wget to download"
  fi
}

# The release asset for this machine, as package.json's build scripts name them.
asset() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux)
      if ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; then
        die "there is no build for musl Linux (such as Alpine) yet; build from source with Bun"
      fi
      os=linux ;;
    Darwin)
      os=darwin
      # A shell under Rosetta reports x86_64 on Apple Silicon: the arm64 build is the right one.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then arch=arm64; fi ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      die "on Windows, download cc-remote-windows-x64.exe from https://github.com/$REPO/releases; after that, \`cc-remote update\` works" ;;
    *) die "there is no build for $os" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "there is no build for $os on $arch" ;;
  esac
  [ "$os-$arch" != darwin-x64 ] || die "there is no build for Intel Macs; build from source with Bun"
  printf 'cc-remote-%s-%s' "$os" "$arch"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "needs sha256sum or shasum to check the download; nothing was installed"
  fi
}

# install.json's "current", or nothing.
current_version() {
  [ -f "$1" ] || return 0
  sed -n 's/.*"current"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

main() {
  setup=1
  for a in "$@"; do [ "$a" != --no-setup ] || setup=0; done
  name=$(asset)
  base=${CC_REMOTE_RELEASE_BASE:-https://github.com/$REPO/releases}
  if [ -n "${CC_REMOTE_VERSION:-}" ]; then url="$base/download/v${CC_REMOTE_VERSION#v}"; else url="$base/latest/download"; fi

  root="$HOME/.local/share/cc-remote"
  versions="$root/versions"
  bin="$HOME/.local/bin"
  stable="$bin/cc-remote"
  umask 077
  mkdir -p "$versions" "$bin"
  chmod 700 "$root" "$versions"
  partial="$versions/.partial-$$"
  rm -rf "$partial"
  mkdir "$partial"
  trap 'rm -rf "$partial"' EXIT

  say "Downloading $name from $url ..."
  fetch "$url/$name" "$partial/$name" || die "could not download $url/$name"
  fetch "$url/SHA256SUMS" "$partial/SHA256SUMS" || die "could not download $url/SHA256SUMS"
  expected=$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1; exit }' "$partial/SHA256SUMS")
  [ -n "$expected" ] || die "SHA256SUMS lists no $name; nothing was installed"
  actual=$(sha256 "$partial/$name")
  [ "$actual" = "$expected" ] || die "$name doesn't match SHA256SUMS (expected $expected, got $actual); nothing was installed"
  mv "$partial/$name" "$partial/cc-remote"
  rm -f "$partial/SHA256SUMS"
  chmod 755 "$partial/cc-remote"

  out=$("$partial/cc-remote" --version 2>&1) || die "the downloaded binary doesn't run: $out"
  version=${out%% *}
  case "$version" in [0-9]*.[0-9]*.[0-9]*) ;; *) die "the downloaded binary printed an unexpected version: $out" ;; esac
  if [ -n "${CC_REMOTE_VERSION:-}" ] && [ "$version" != "${CC_REMOTE_VERSION#v}" ]; then
    die "asked for ${CC_REMOTE_VERSION#v} but the download is $version"
  fi

  if [ -d "$versions/$version" ]; then
    # This version is installed already, and may be running: keep that copy.
    rm -rf "$partial"
  else
    mv "$partial" "$versions/$version"
  fi
  trap - EXIT

  # The stable path: a regular file there (a copy installed by hand) is kept aside, never lost.
  if [ -d "$stable" ] && [ ! -L "$stable" ]; then die "$stable is a folder; move it aside and run the installer again"; fi
  if [ -L "$stable" ] && [ -d "$stable" ]; then die "$stable links to a folder; move it aside and run the installer again"; fi
  if [ -e "$stable" ] && [ ! -L "$stable" ]; then
    aside="$stable.unmanaged-$(date +%Y%m%d%H%M%S)"
    mv "$stable" "$aside"
    say "Moved the existing $stable to $aside (it wasn't installed by this installer)."
  fi
  previous=$(current_version "$root/install.json")
  ln -s "$versions/$version/cc-remote" "$bin/.cc-remote.new.$$"
  mv -f "$bin/.cc-remote.new.$$" "$stable"

  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ -n "$previous" ] && [ "$previous" != "$version" ]; then prev_json="\"previous\":\"$previous\","; else prev_json=""; fi
  printf '{"current":"%s",%s"installedAt":"%s","source":"github:%s"}\n' "$version" "$prev_json" "$now" "$REPO" > "$root/install.json.$$"
  mv -f "$root/install.json.$$" "$root/install.json"

  say "Installed cc-remote $version: $stable -> $versions/$version/cc-remote"
  "$stable" --version
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) say "Note: $bin is not on your PATH. Add it in your shell's startup file (this installer doesn't edit it):"
       say "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac

  [ "$setup" = 1 ] || return 0
  # Setup is interactive. Under `curl | sh` stdin is this script, so it reads the terminal.
  first=1
  for a in "$@"; do
    if [ "$first" = 1 ]; then set --; first=0; fi
    [ "$a" = --no-setup ] || set -- "$@" "$a"
  done
  if (: </dev/tty) 2>/dev/null; then
    "$stable" setup "$@" </dev/tty
  elif [ "$#" -gt 0 ]; then
    "$stable" setup "$@" </dev/null
  else
    say "Next: run \`cc-remote setup\` in a terminal."
  fi
}

main "$@"
