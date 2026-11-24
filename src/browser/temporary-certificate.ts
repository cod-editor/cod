import { randomUUID, X509Certificate } from "node:crypto";
import { isIPv4 } from "node:net";
import { session } from "electron";

export type CertificateIdentity = { origin: string; fingerprint: string };

export function localCertificate(
  address: string,
  error: string,
  data: string,
): CertificateIdentity | undefined {
  if (
    error !== "net::ERR_CERT_AUTHORITY_INVALID" &&
    error !== "net::ERR_CERT_SELF_SIGNED_LOCAL_NETWORK"
  )
    return;
  try {
    const url = new URL(address);
    const parts = url.hostname.split(".").map(Number);
    // HSTS host matching excludes IP literals. Electron does not expose its
    // strict enforcement flag, so keep hostnames on Chromium's normal path.
    const privateIp =
      isIPv4(url.hostname) &&
      (parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168));
    if (!privateIp || url.protocol !== "https:" || url.username || url.password)
      return;
    const leaf = new X509Certificate(data);
    const now = Date.now();
    if (
      !leaf.checkIP(url.hostname) ||
      !(
        leaf.validFromDate.getTime() <= now && now <= leaf.validToDate.getTime()
      )
    )
      return;
    return { origin: url.origin, fingerprint: leaf.fingerprint256 };
  } catch {
    return;
  }
}

export function certificateSession(identity: CertificateIdentity) {
  const network = session.fromPartition(`cod-temporary-${randomUUID()}`, {
    cache: false,
  });
  let closed = false;
  const allows = (address: string) => {
    if (closed) return false;
    try {
      const url = new URL(address);
      return (
        url.protocol === "https:" &&
        url.origin === identity.origin &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  };
  network.webRequest.onBeforeRequest(({ url }, done) =>
    done({ cancel: !allows(url) }),
  );
  network.setPermissionCheckHandler(() => false);
  network.setPermissionRequestHandler((_contents, _permission, done) =>
    done(false),
  );
  network.on("will-download", (event) => event.preventDefault());
  return {
    network,
    allows,
    identity,
    close() {
      closed = true;
      void Promise.allSettled([
        network.closeAllConnections(),
        network.clearStorageData(),
      ]);
    },
  };
}
