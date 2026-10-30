#!/bin/zsh
set -euo pipefail

CERT_NAME="${1:-PiWeb Local Developer}"
OUTPUT_DIR="${2:-$HOME/.prismbrowser/certs}"
KEYCHAIN="${KEYCHAIN:-$(security default-keychain | tr -d '" \t')}"

if [[ -z "$KEYCHAIN" ]]; then
    KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
fi

echo "==> Setting up persistent Code Signing Certificate: '$CERT_NAME'"
echo "==> Output directory: $OUTPUT_DIR"
echo "==> Target keychain:  $KEYCHAIN"

mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

CNF_PATH="$OUTPUT_DIR/openssl.cnf"
KEY_PATH="$OUTPUT_DIR/key.pem"
CERT_PATH="$OUTPUT_DIR/cert.pem"
P12_PATH="$OUTPUT_DIR/codesign.p12"
PASS_PATH="$OUTPUT_DIR/p12_password.txt"

cat > "$CNF_PATH" <<EOF
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = codesign_ext

[ dn ]
CN = $CERT_NAME

[ codesign_ext ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

if [[ -f "$KEY_PATH" && -f "$CERT_PATH" && -f "$P12_PATH" && -f "$PASS_PATH" ]]; then
    echo "==> Found existing certificate, reusing."
    P12_PASS="$(cat "$PASS_PATH")"
else
    echo "==> Generating new private key and self-signed certificate (valid 10 years)..."
    P12_PASS="$(openssl rand -hex 16)"
    echo -n "$P12_PASS" > "$PASS_PATH"
    chmod 600 "$PASS_PATH"

    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$KEY_PATH" \
        -out "$CERT_PATH" \
        -config "$CNF_PATH" > /dev/null 2>&1
    chmod 600 "$KEY_PATH"

    echo "==> Exporting PKCS#12 bundle..."
    openssl pkcs12 -export -legacy \
        -out "$P12_PATH" \
        -inkey "$KEY_PATH" \
        -in "$CERT_PATH" \
        -passout "pass:$P12_PASS" > /dev/null 2>&1
    chmod 600 "$P12_PATH"
fi

if security find-certificate -c "$CERT_NAME" "$KEYCHAIN" > /dev/null 2>&1; then
    echo "==> Removing existing certificate '$CERT_NAME' from keychain..."
    security delete-certificate -c "$CERT_NAME" "$KEYCHAIN" > /dev/null 2>&1 || true
fi

echo "==> Importing identity into keychain..."
security import "$P12_PATH" -k "$KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign -A

echo "==> Adding code-signing trust..."
security add-trusted-cert -d -r trustRoot -p codeSign "$CERT_PATH"

echo "==> Verifying..."
if security find-identity -p codesigning -v | grep -q "$CERT_NAME"; then
    echo "==> SUCCESS: Found valid codesigning identity: '$CERT_NAME'"
    security find-identity -p codesigning -v | grep "$CERT_NAME"
else
    echo "==> Warning: identity imported but not listed as valid." >&2
    exit 1
fi

echo ""
echo "=================================================================="
echo " Local Code Signing Certificate Ready!"
echo " Name:     $CERT_NAME"
echo " Location: $P12_PATH"
echo "=================================================================="
echo ""
echo "Now add to electron-builder config:"
echo "  CSC_NAME=\"$CERT_NAME\" npx electron-builder --mac dir"
