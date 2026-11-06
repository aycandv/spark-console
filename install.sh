#!/bin/sh
# Install or update spark-console for your user. Run: curl -fsSL https://raw.githubusercontent.com/aycandv/spark-console/main/install.sh | sh
# Options: -y (or SPARK_CONSOLE_YES=1) skips the question. SPARK_CONSOLE_DIR sets the clone folder, SPARK_CONSOLE_REPO the clone source.
# All code is in main, which the last line calls, so a download that stops early runs nothing.
set -eu

die() {
    echo "$*" >&2
    exit 1
}

main() {
    yes=${SPARK_CONSOLE_YES:-0}
    case ${1:-} in
        -y) yes=1 ;;
        "") ;;
        *) die "Unknown option $1. The only option is -y." ;;
    esac

    # Every check runs before the first change.
    [ "$(id -u)" -ne 0 ] || die "Run as your own user, not root."
    arch=$(uname -sm)
    [ "$arch" = "Linux aarch64" ] || die "spark-console needs Linux on aarch64 (a DGX Spark), not $arch."
    command -v nvidia-smi >/dev/null || die "nvidia-smi not found. Install the NVIDIA driver first."
    python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))' 2>/dev/null || die "python3 is missing or older than 3.12."
    command -v git >/dev/null || die "git not found. Install it: sudo apt install git"
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    systemctl --user show-environment >/dev/null 2>&1 || die "systemctl --user does not work. Log in as your user (not su or sudo -u) and run again."
    command -v tailscale >/dev/null || die "tailscale not found. Install Tailscale first: https://tailscale.com/download/linux"
    tailscale status >/dev/null 2>&1 || die "Tailscale is not running or not logged in. Run sudo tailscale up, then run this again."

    repo=${SPARK_CONSOLE_REPO:-https://github.com/aycandv/spark-console}
    dir=${SPARK_CONSOLE_DIR:-$HOME/projects/spark-console}
    case $dir in /*) ;; *) die "SPARK_CONSOLE_DIR must be an absolute path, not $dir." ;; esac
    unit_dir=$HOME/.config/systemd/user
    set -- --bg --https=9443 "unix:$XDG_RUNTIME_DIR/spark-console/http.sock" # the tailscale serve arguments
    if [ -e "$dir" ] && [ ! -f "$dir/deploy/install.sh" ]; then
        die "$dir exists but is not a spark-console clone. Move it away or set SPARK_CONSOLE_DIR."
    fi

    echo "The spark-console installer will:"
    if [ -e "$dir" ]; then
        echo "  1. Use the clone in $dir as it is."
    else
        echo "  1. Clone $repo to $dir."
    fi
    echo "  2. Run sudo sh $dir/deploy/install.sh: the root helper, its sudoers rule, the boot units if missing, lingering."
    echo "  3. Install the user service spark-console in $unit_dir and start it."
    echo "  4. Run tailscale serve $* (with sudo if your user may not)."
    echo "Step 2 lets your user run spark_console/helper.py as root without a password. Read it first:"
    echo "  https://github.com/aycandv/spark-console/blob/main/spark_console/helper.py"
    if [ "$yes" != 1 ]; then
        printf 'Continue? [y/N] '
        read -r answer 2>/dev/null </dev/tty || die "No terminal for the question. Run again with -y to skip it."
        case $answer in
            y | Y | yes | Yes) ;;
            *) die "Stopped. Nothing changed." ;;
        esac
    fi

    [ -e "$dir" ] || git clone "$repo" "$dir"
    sudo sh "$dir/deploy/install.sh"

    mkdir -p "$unit_dir"
    sed "s|%h/projects/spark-console|$dir|" "$dir/deploy/spark-console.service" >"$unit_dir/spark-console.service"
    systemctl --user daemon-reload
    systemctl --user try-restart spark-console # a re-run loads the new code
    systemctl --user enable --now spark-console

    if ! tailscale serve "$@"; then
        echo "tailscale serve needs sudo for your user. To skip sudo next time: sudo tailscale set --operator=\$USER"
        sudo tailscale serve "$@"
    fi

    host=$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null) ||
        die "Could not read this machine's name from tailscale status --json."
    echo "Open the console on a device in your tailnet:"
    echo "https://$host:9443/"
}

main "$@"
