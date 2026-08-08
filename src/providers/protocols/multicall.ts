import 'server-only';

import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, hexToString } from 'viem';
import type { Hex } from 'viem';

import type { RpcRequester } from '../balances/jsonRpc';
import { ProviderError } from '../types';

/**
 * The bits of `Multicall3` decoding both Aave readers need.
 *
 * Extracted when the rewards reader arrived rather than before it: one caller is not
 * evidence that a helper is shared. Two are, and the alternative was a second copy of
 * the length check, which is the part that must not drift.
 */

const aggregate3Abi = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

export type Call = { target: string; allowFailure: boolean; callData: string };

/**
 * One `Multicall3.aggregate3`, with the length of the answer checked against the
 * length of the question.
 *
 * Results are matched to calls by position, so a short answer would silently read each
 * asset's numbers from its neighbour rather than fail.
 */
export async function aggregate3(
  requester: RpcRequester,
  multicallAddress: string,
  calls: readonly Call[],
  providerId: string,
): Promise<readonly { success: boolean; returnData: Hex }[]> {
  const raw = await requester({
    method: 'eth_call',
    params: [
      {
        to: multicallAddress,
        data: encodeFunctionData({
          abi: aggregate3Abi,
          functionName: 'aggregate3',
          args: [calls as readonly { target: Hex; allowFailure: boolean; callData: Hex }[]],
        }),
      },
      'latest',
    ],
  });

  const results = decodeFunctionResult({
    abi: aggregate3Abi,
    functionName: 'aggregate3',
    data: assertHex(raw, providerId),
  });

  if (results.length !== calls.length) {
    throw new ProviderError(
      'invalid-response',
      providerId,
      `Multicall returned ${results.length} results for ${calls.length} calls`,
    );
  }

  return results;
}

/**
 * A token's symbol, whichever of the two shapes it returns it in.
 *
 * A `bytes32` response is exactly 32 bytes; the shortest ABI-encoded string is 64.
 * Anything that decodes to nothing usable is null, which the UI renders as the address.
 * MKR, one of the 80 Ethereum reserves, is the reason this is not a plain string decode.
 */
export function decodeSymbol(data: Hex): string | null {
  try {
    const symbol =
      (data.length - 2) / 2 === 32
        ? hexToString(data, { size: 32 })
        : decodeAbiParameters([{ type: 'string' }], data)[0];
    return symbol.length === 0 ? null : symbol;
  } catch {
    return null;
  }
}

/** An address packed into a 32-byte word, as every `address`-returning call gives it. */
export function decodeAddress(data: Hex | undefined, providerId: string): string {
  return `0x${assertHex(data, providerId).slice(-40)}`;
}

export function assertHex(value: unknown, providerId: string): Hex {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new ProviderError('unavailable', providerId, 'eth_call did not return hex');
  }
  return value as Hex;
}
