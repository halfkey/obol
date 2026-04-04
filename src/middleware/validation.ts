import type { FastifyRequest, FastifyReply } from 'fastify';
import { PublicKey } from '@solana/web3.js';

/** Validate :address param is a valid Solana public key */
export async function validateSolanaAddress(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { address } = request.params as { address?: string };

  if (!address) {
    return reply.code(400).send({
      error: 'Bad Request',
      message: 'Missing wallet address',
    });
  }

  try {
    new PublicKey(address);
  } catch {
    return reply.code(400).send({
      error: 'Bad Request',
      message: `Invalid Solana address: ${address}`,
    });
  }
}

/** Validate :mint param is a valid Solana public key (token mint) */
export async function validateMintAddress(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { mint } = request.params as { mint?: string };

  if (!mint) {
    return reply.code(400).send({
      error: 'Bad Request',
      message: 'Missing token mint address',
    });
  }

  try {
    new PublicKey(mint);
  } catch {
    return reply.code(400).send({
      error: 'Bad Request',
      message: `Invalid token mint: ${mint}`,
    });
  }
}
