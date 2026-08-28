export function pairingLinkFromHash(hash) {
  if (typeof hash !== "string" || hash.length > 8192 || !hash.startsWith("#")) return "";
  const values = new URLSearchParams(hash.slice(1));
  if ([...values.keys()].some((key) => key !== "pairingLink")) return "";
  const links = values.getAll("pairingLink");
  if (links.length !== 1) return "";
  const link = links[0].trim();
  if (
    !link.startsWith("convenewire://pair-device?") &&
    !link.startsWith("agentroom://pair-device?")
  ) return "";
  return link;
}
