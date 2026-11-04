#!/bin/sh
# Remove the spark-console root helper, its sudoers rule and its boot drop-ins. Run: sudo deploy/uninstall.sh
# Without the drop-ins, gb10-clocklock and cpu-epp go back to the values in their own unit files.
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo deploy/uninstall.sh" >&2; exit 1; }

rm -f /etc/systemd/system/gb10-clocklock.service.d/50-spark-console.conf \
      /etc/systemd/system/cpu-epp.service.d/50-spark-console.conf
rmdir /etc/systemd/system/gb10-clocklock.service.d /etc/systemd/system/cpu-epp.service.d 2>/dev/null || true
systemctl daemon-reload
rm -f /etc/sudoers.d/spark-console /usr/local/sbin/spark-console-helper
rm -rf /run/spark-console

echo "Removed. Current clocks stay until reboot; run 'sudo systemctl restart gb10-clocklock cpu-epp' to re-apply the boot values now."
