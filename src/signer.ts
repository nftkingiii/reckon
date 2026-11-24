// An EIP-191 personal_sign signer built from a private key in the environment. The key is read once, held in a closure,
// and never logged, returned, or placed in an error message.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import type { EscrowSigner } from "./telegraph.ts";

/** EIP-55 mixed-case address from 20 address bytes. */
function checksumAddress(addr: Uint8Array): string {
  const lower = bytesToHex(addr);
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i];
  return out;
}

export function signerFromKey(raw: string): EscrowSigner {
  let key = raw.trim();
  if (!key.startsWith("0x")) key = `0x${key}`;
  // The message below must not echo the value: it could be a real key with a typo.
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("RECKON_SIGNER_KEY is not a 32-byte hex key");
  const priv = hexToBytes(key.slice(2));
  if (!secp256k1.utils.isValidPrivateKey(priv)) throw new Error("RECKON_SIGNER_KEY is not a valid secp256k1 key");
  const address = checksumAddress(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(-20));
  return {
    address,
    async personalSign(message: string): Promise<string> {
      const body = utf8ToBytes(message);
      const digest = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), ...body]));
      const sig = secp256k1.sign(digest, priv);
      return `0x${sig.r.toString(16).padStart(64, "0")}${sig.s.toString(16).padStart(64, "0")}${(27 + sig.recovery).toString(16)}`;
    },
  };
}

/** The address that signed `message`, for tests. */
export function recoverAddress(message: string, signature: string): string {
  const body = utf8ToBytes(message);
  const digest = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), ...body]));
  const hex = signature.slice(2);
  const sig = secp256k1.Signature.fromCompact(hex.slice(0, 128)).addRecoveryBit(parseInt(hex.slice(128), 16) - 27);
  return checksumAddress(keccak_256(sig.recoverPublicKey(digest).toRawBytes(false).slice(1)).slice(-20));
}
