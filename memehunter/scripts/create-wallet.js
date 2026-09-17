import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const kp = Keypair.generate();
console.log('ADDRESS=' + kp.publicKey.toBase58());
console.log('BS58_PRIVATE_KEY=' + bs58.encode(kp.secretKey));
console.log('\nIMPORTANT: paste the private key directly into Railway BS58_PRIVATE_KEY. Never send it in chat/Telegram or commit it to GitHub.');
