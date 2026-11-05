#!/bin/sh
# Install the spark-console root helper, its sudoers rule and (if missing) the two boot units. Run: sudo deploy/install.sh
# The helper is copied (root-owned), so the user cannot change what runs as root.
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo deploy/install.sh" >&2; exit 1; }
target_user=${SUDO_USER:-}
if [ -z "$target_user" ] || [ "$target_user" = root ]; then
    echo "Run through sudo from your own account." >&2
    exit 1
fi

repo=$(cd "$(dirname "$0")/.." && pwd)
helper=/usr/local/sbin/spark-console-helper
rule=/etc/sudoers.d/spark-console

install -o root -g root -m 0755 "$repo/spark_console/helper.py" "$helper"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf '# spark-console: the helper checks every action and value itself.\n%s ALL=(root) NOPASSWD: %s\n' "$target_user" "$helper" > "$tmp"
visudo -cf "$tmp" >/dev/null
install -o root -g root -m 0440 "$tmp" "$rule"

# Boot units that "Keep after reboot" writes drop-ins for. An existing unit is never replaced.
for unit in gb10-clocklock.service cpu-epp.service; do
    if [ ! -e "/etc/systemd/system/$unit" ]; then
        install -o root -g root -m 0644 "$repo/deploy/$unit" "/etc/systemd/system/$unit"
        systemctl daemon-reload
        systemctl enable "$unit"
        echo "Installed /etc/systemd/system/$unit (no GPU cap, EPP 0)."
    fi
done

# Let the user service run without an open login session.
loginctl enable-linger "$target_user"

echo "Installed $helper and $rule for user $target_user."
