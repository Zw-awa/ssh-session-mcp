#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Zw-awa
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

TRIVY_VERSION="${TRIVY_VERSION:-0.70.0}"
TRIVY_ARCHIVE="trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
TRIVY_CHECKSUMS="trivy_${TRIVY_VERSION}_checksums.txt"
TRIVY_BASE_URL="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}"

curl -fsSL "${TRIVY_BASE_URL}/${TRIVY_ARCHIVE}" -o "${TRIVY_ARCHIVE}"
curl -fsSL "${TRIVY_BASE_URL}/${TRIVY_CHECKSUMS}" -o "${TRIVY_CHECKSUMS}"

grep " ${TRIVY_ARCHIVE}\$" "${TRIVY_CHECKSUMS}" | sha256sum --check --status

tar -xzf "${TRIVY_ARCHIVE}" trivy
sudo mv trivy /usr/local/bin/trivy
trivy --version
