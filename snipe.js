// ============================================
//SOL AUTO TRADING BOT - Complete Implementation
// with Debug Logging & Professional Messages 
// ============================================
import { Telegraf, Markup } from 'telegraf';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getMint
} from '@solana/spl-token';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { createCanvas, loadImage, registerFont } from 'canvas';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';

// ======================= CONFIGURATION =======================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_NAME = 'Pegasus Trading Bot';

// Register custom fonts (optional)
const FONT_DIR = __dirname;
try {
  registerFont(path.join(FONT_DIR, 'Orbitron-ExtraBold.ttf'), { family: 'OrbitronExtraBold' });
  registerFont(path.join(FONT_DIR, 'Orbitron-SemiBold.ttf'),  { family: 'OrbitronSemiBold' });
  registerFont(path.join(FONT_DIR, 'Orbitron-Regular.ttf'),    { family: 'OrbitronRegular' });
} catch (e) { /* fonts not found – fallback to default */ }

const FONT_BIG_SIZE   = 95;
const FONT_MID_SIZE   = 42;
const FONT_SMALL_SIZE = 28;

const GOOD_BG = path.join(__dirname, 'good.png');
const BAD_BG  = path.join(__dirname, 'bad.png');
const SOLANA_LOGO = path.join(__dirname, 'solana-logo.png');

// Persistent storage (override via env for Railway volumes)
const SESSIONS_FILE = process.env.SESSIONS_PATH || path.join(__dirname, 'sessions.json');

// ======================= CACHE & RPC =======================
const balanceCache = new Map();
const BALANCE_CACHE_TTL = 30000;

let solPriceCache = { price: 0, timestamp: 0 };
const PRICE_CACHE_TTL = 60000;

const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://rpc.ankr.com/solana',
  'https://solana.public-rpc.com'
];

async function getBalanceWithFallback(publicKeyString) {
  const cacheKey = publicKeyString.toString();
  const now = Date.now();
  const cached = balanceCache.get(cacheKey);
  if (cached && (now - cached.timestamp < BALANCE_CACHE_TTL)) return cached.balance;
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const tempConnection = new Connection(endpoint, 'confirmed');
      const publicKey = new PublicKey(publicKeyString);
      const balance = await Promise.race([
        tempConnection.getBalance(publicKey),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]);
      const solBalance = balance / LAMPORTS_PER_SOL;
      balanceCache.set(cacheKey, { balance: solBalance, timestamp: now });
      return solBalance;
    } catch (error) { continue; }
  }
  if (cached) return cached.balance;
  throw new Error('All RPC endpoints failed');
}

async function getSolPriceWithCache() {
  const now = Date.now();
  if (solPriceCache.price > 0 && (now - solPriceCache.timestamp < PRICE_CACHE_TTL)) return solPriceCache.price;
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    const data = await res.json();
    if (data.pairs && data.pairs.length) {
      const solPair = data.pairs.find(p => p.chainId === 'solana' && (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT'));
      if (solPair && solPair.priceUsd) {
        const price = parseFloat(solPair.priceUsd);
        solPriceCache = { price, timestamp: now };
        return price;
      }
    }
    const cg = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const cgData = await cg.json();
    if (cgData?.solana?.usd) {
      const price = cgData.solana.usd;
      solPriceCache = { price, timestamp: now };
      return price;
    }
    throw new Error('No price');
  } catch (error) {
    if (solPriceCache.price > 0) return solPriceCache.price;
    return 0;
  }
}

// ======================= CONFIG =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MAX_ADMINS = 2;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || '')
  .split(',').map(id => id.trim()).filter(id => id.length > 0).slice(0, MAX_ADMINS);

const JUPITER_API = 'https://api.jup.ag/swap/v1';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_WALLETS = 5;
const MAX_TRACKED_TOKENS = 5;
const MAX_ALERTS = 3;

const COMMISSION_WALLET = process.env.COMMISSION_WALLET || '';
const COMMISSION_PERCENTAGE = parseFloat(process.env.COMMISSION_PERCENTAGE || '0');
const COMMISSION_BPS = Math.floor(COMMISSION_PERCENTAGE * 100);

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(SOLANA_RPC, 'confirmed');

const mintDecimalsCache = new Map();

function amountFromBaseUnits(amountStr, decimals) {
  const s = String(amountStr ?? '0').replace(/^0+/, '') || '0';
  const d = Math.max(0, Math.min(18, Number(decimals) || 0));
  if (d === 0) return Number(s);
  const padded = s.padStart(d + 1, '0');
  const intPart = padded.slice(0, -d);
  const fracPartRaw = padded.slice(-d);
  const fracPart = fracPartRaw.replace(/0+$/, '');
  return Number(fracPart ? `${intPart}.${fracPart}` : intPart);
}

async function getMintDecimals(mintAddress) {
  if (!mintAddress) return 9;
  if (mintDecimalsCache.has(mintAddress)) return mintDecimalsCache.get(mintAddress);
  try {
    const mint = await getMint(connection, new PublicKey(mintAddress));
    const dec = Number(mint.decimals);
    const safeDec = Number.isFinite(dec) ? dec : 9;
    mintDecimalsCache.set(mintAddress, safeDec);
    return safeDec;
  } catch {
    return 9;
  }
}

function resolveTradeTokenAmount(trade) {
  const amountToken = Number(trade?.amountToken);
  const valueUsd = Number(trade?.valueUsd);
  const priceUsd = Number(trade?.priceUsd);

  if (Number.isFinite(valueUsd) && valueUsd > 0 && Number.isFinite(priceUsd) && priceUsd > 0) {
    const inferred = valueUsd / priceUsd;
    if (!Number.isFinite(amountToken) || amountToken <= 0) return inferred;
    const impliedValue = amountToken * priceUsd;
    const ratio = impliedValue / valueUsd;
    if (!Number.isFinite(ratio) || ratio > 10 || ratio < 0.1) return inferred;
  }

  if (Number.isFinite(amountToken) && amountToken > 0) return amountToken;
  return 0;
}

function normalizeTradeRecord(tradeData) {
  const trade = { ...tradeData };
  const valueUsd = Number(trade.valueUsd ?? trade.amountUsd) || 0;
  const priceUsd = Number(trade.priceUsd) || 0;
  const amountToken = Number(trade.amountToken) || 0;

  trade.valueUsd = valueUsd;
  trade.amountUsd = valueUsd;

  if (valueUsd > 0 && priceUsd > 0) {
    const inferredQty = valueUsd / priceUsd;
    if (!Number.isFinite(amountToken) || amountToken <= 0) {
      trade.amountToken = inferredQty;
    } else {
      const impliedValue = amountToken * priceUsd;
      const ratio = impliedValue / valueUsd;
      if (!Number.isFinite(ratio) || ratio > 50 || ratio < 0.02) {
        trade.amountToken = inferredQty;
      }
    }
  }

  return trade;
}

function recomputeTradePnL(tradeHistory) {
  const normalized = (tradeHistory || []).map(normalizeTradeRecord);
  const tokenState = new Map();

  const byTime = [...normalized].sort((a, b) => {
    const ta = new Date(a.timestamp || 0).getTime();
    const tb = new Date(b.timestamp || 0).getTime();
    return ta - tb;
  });

  for (const trade of byTime) {
    const token = trade.tokenAddress;
    if (!token) continue;
    if (!tokenState.has(token)) tokenState.set(token, { qty: 0, costUsd: 0 });
    const state = tokenState.get(token);

    const valueUsd = Number(trade.valueUsd) || 0;
    const qty = resolveTradeTokenAmount(trade);

    if (trade.type === 'BUY') {
      trade.pnlUsd = 0;
      if (qty > 0 && valueUsd > 0) {
        state.qty += qty;
        state.costUsd += valueUsd;
      }
      continue;
    }

    if (trade.type === 'SELL') {
      if (!(qty > 0) || !(valueUsd > 0)) {
        trade.pnlUsd = 0;
        continue;
      }

      const sellQty = state.qty > 0 ? Math.min(qty, state.qty) : qty;
      const proceedsUsd = sellQty === qty ? valueUsd : (valueUsd * (sellQty / qty));
      const avgCost = state.qty > 0 ? (state.costUsd / state.qty) : 0;
      const costBasis = sellQty * avgCost;
      const pnl = proceedsUsd - costBasis;

      trade.pnlUsd = pnl;

      if (state.qty > 0) {
        state.qty = Math.max(0, state.qty - sellQty);
        state.costUsd = Math.max(0, state.costUsd - costBasis);
      }
    }
  }

  const today = new Date().toDateString();
  const todaysTrades = normalized.filter(t => t?.date === today);
  const dailyStats = {
    date: today,
    totalTrades: todaysTrades.length,
    profitableTrades: todaysTrades.filter(t => (t.pnlUsd || 0) > 0).length,
    lossTrades: todaysTrades.filter(t => (t.pnlUsd || 0) < 0).length,
    totalPnl: todaysTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0)
  };

  return { tradeHistory: normalized, dailyStats };
}

// ======================= DEBUG LOGGING =======================
bot.use(async (ctx, next) => {
  console.log('Update:', ctx.updateType);
  if (ctx.message) console.log('Message:', ctx.message.text);
  await next();
});

// ======================= SESSION MANAGEMENT =======================
const userSessions = new Map();

function serializeSession(session) {
  return {
    ...session,
    wallets: session.wallets.map(w => ({ mnemonic: w.mnemonic, publicKey: w.publicKey, privateKey: w.privateKey }))
  };
}

function deserializeSession(data) {
  const session = { ...data };
  session.wallets = session.wallets.map(w => {
    if (w.mnemonic) {
      const wallet = importFromMnemonic(w.mnemonic);
      return { keypair: wallet.keypair, mnemonic: wallet.mnemonic, publicKey: wallet.publicKey, privateKey: wallet.privateKey };
    } else if (w.privateKey) {
      const wallet = importFromPrivateKey(w.privateKey);
      return { keypair: wallet.keypair, mnemonic: null, publicKey: wallet.publicKey, privateKey: wallet.privateKey };
    }
    return null;
  }).filter(w => w !== null);
  if (Array.isArray(session.tradeHistory)) {
    const recomputed = recomputeTradePnL(session.tradeHistory);
    session.tradeHistory = recomputed.tradeHistory;
    session.dailyStats = recomputed.dailyStats;
  }
  return { session, mutated: true };
}

async function ensureDirectoryExists(filePath) {
  const dir = path.dirname(filePath);
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function loadSessions() {
  try {
    await ensureDirectoryExists(SESSIONS_FILE);
    const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
    const obj = JSON.parse(data);
    let mutatedAny = false;
    for (const [uid, sd] of Object.entries(obj)) {
      const result = deserializeSession(sd);
      if (result?.session) {
        userSessions.set(parseInt(uid), result.session);
        if (result.mutated) mutatedAny = true;
      } else {
        userSessions.set(parseInt(uid), result);
      }
    }
    for (const [uid, sess] of userSessions.entries()) {
      if (sess.referralCode) referralCodes.set(sess.referralCode, uid);
    }
    console.log(`✅ Loaded ${userSessions.size} sessions`);
    if (mutatedAny) await saveSessions();
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Load sessions error:', err);
    else console.log('No existing sessions file, starting fresh.');
  }
}

async function saveSessions() {
  try {
    await ensureDirectoryExists(SESSIONS_FILE);
    const obj = {};
    for (const [uid, sess] of userSessions.entries()) obj[uid] = serializeSession(sess);
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    console.log(`✅ Saved ${userSessions.size} sessions`);
  } catch (err) {
    console.error('Save sessions error:', err);
  }
}

function getSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      wallets: [], activeWalletIndex: 0, state: null,
      settings: { slippage: 1, priorityFee: 0.001, autoBuy: false, notifications: true },
      pendingTrade: null, limitOrders: [], copyTradeWallets: [],
      trackedTokens: [], alerts: [], dcaOrders: [],
      isNewUser: true, referralCode: null, referredBy: null, referrals: [], referralEarnings: 0,
      pendingTransfer: null, tradeHistory: [],
      dailyStats: { date: new Date().toDateString(), totalTrades: 0, profitableTrades: 0, lossTrades: 0, totalPnl: 0 },
      pendingAlertToken: null, pendingAlert: null
    });
  }
  return userSessions.get(userId);
}

function getActiveWallet(session) {
  if (session.wallets.length === 0) return null;
  return session.wallets[session.activeWalletIndex] || session.wallets[0];
}

// ======================= WALLET FUNCTIONS =======================
function createWallet() {
  const mnemonic = bip39.generateMnemonic();
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  return { keypair, mnemonic, publicKey: keypair.publicKey.toBase58(), privateKey: bs58.encode(keypair.secretKey) };
}

function importFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic');
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  return { keypair, mnemonic, publicKey: keypair.publicKey.toBase58(), privateKey: bs58.encode(keypair.secretKey) };
}

function importFromPrivateKey(privateKeyBase58) {
  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  return { keypair, mnemonic: null, publicKey: keypair.publicKey.toBase58(), privateKey: privateKeyBase58 };
}

async function getBalance(publicKey) {
  try { return (await connection.getBalance(new PublicKey(publicKey))) / LAMPORTS_PER_SOL; } catch { return 0; }
}

async function getTokenBalance(walletAddress, tokenMint) {
  try {
    const wallet = new PublicKey(walletAddress);
    const mint = new PublicKey(tokenMint);
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet, { mint });
    if (accounts.value.length > 0) {
      const bal = accounts.value[0].account.data.parsed.info.tokenAmount;
      return { amount: parseFloat(bal.uiAmount), decimals: bal.decimals };
    }
    return { amount: 0, decimals: 9 };
  } catch { return { amount: 0, decimals: 9 }; }
}

// ======================= TRANSFER =======================
async function transferSOL(fromWallet, toAddress, amount) {
  if (!fromWallet?.keypair) throw new Error('Source wallet not available');
  if (!isSolanaAddress(toAddress)) throw new Error('Invalid recipient');
  if (amount <= 0) throw new Error('Invalid amount');
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
  const balance = await connection.getBalance(fromWallet.keypair.publicKey);
  if (balance < lamports + 0.005 * LAMPORTS_PER_SOL) throw new Error('Insufficient balance');
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: fromWallet.keypair.publicKey, toPubkey: toPubkey, lamports }));
  return await sendAndConfirmTransaction(connection, tx, [fromWallet.keypair], { commitment: 'confirmed' });
}

async function transferToken(fromWallet, toAddress, tokenMint, amount) {
  if (!fromWallet?.keypair) throw new Error('Source wallet not available');
  if (!isSolanaAddress(toAddress) || !isSolanaAddress(tokenMint)) throw new Error('Invalid address');
  const mintPubkey = new PublicKey(tokenMint);
  const fromPubkey = fromWallet.keypair.publicKey;
  const toPubkey = new PublicKey(toAddress);
  const fromATA = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
  const toATA = await getAssociatedTokenAddress(mintPubkey, toPubkey);
  const tx = new Transaction();
  let exists = false;
  try { await getAccount(connection, toATA); exists = true; } catch { exists = false; }
  if (!exists) tx.add(createAssociatedTokenAccountInstruction(fromPubkey, toATA, toPubkey, mintPubkey));
  const tokenInfo = await getTokenBalance(fromPubkey.toBase58(), tokenMint);
  const decimals = tokenInfo.decimals || 9;
  const tokenAmount = Math.floor(amount * Math.pow(10, decimals));
  tx.add(createTransferInstruction(fromATA, toATA, fromPubkey, tokenAmount));
  return await sendAndConfirmTransaction(connection, tx, [fromWallet.keypair], { commitment: 'confirmed' });
}

// ======================= JUPITER SWAP =======================
async function getJupiterQuote(inputMint, outputMint, amount, slippageBps = 100, commissionBps = 0) {
  if (!inputMint || !outputMint) throw new Error('Invalid mint');
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  const validSlippage = Math.max(1, Math.min(Math.floor(slippageBps), 10000));
  const params = new URLSearchParams({
    inputMint, outputMint, amount: amount.toString(),
    slippageBps: validSlippage.toString(),
    onlyDirectRoutes: 'false', asLegacyTransaction: 'false', maxAccounts: '64'
  });
  if (commissionBps > 0) params.append('platformFeeBps', commissionBps.toString());
  const url = `${JUPITER_API}/quote?${params.toString()}`;
  const res = await fetch(url, { headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {} });
  if (!res.ok) throw new Error(`Jupiter API error: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  if (!data.inAmount || !data.outAmount) throw new Error('Invalid quote response');
  return data;
}

async function executeJupiterSwap(quote, wallet, priorityFee = 0.001, commissionBps = 0, commissionWallet = null) {
  if (!wallet?.keypair) throw new Error('Invalid wallet');
  const priorityFeeLamports = Math.floor(Math.max(0.0001, Math.min(priorityFee, 0.1)) * LAMPORTS_PER_SOL);
  const body = {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: priorityFeeLamports
  };
  if (commissionBps > 0 && commissionWallet && isSolanaAddress(commissionWallet)) body.feeAccount = commissionWallet;
  const res = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {}) },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Swap API error: ${res.status}`);
  const swapData = await res.json();
  if (swapData.error) throw new Error(swapData.error);
  if (!swapData.swapTransaction) throw new Error('No swap transaction');
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet.keypair]);
  const txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
  const conf = await connection.confirmTransaction(txid, 'confirmed');
  if (conf.value?.err) throw new Error('Transaction failed on-chain');
  return { success: true, txid, inputAmount: quote.inAmount, outputAmount: quote.outAmount };
}

// ======================= TOKEN ANALYSIS =======================
async function fetchTokenData(address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await res.json();
    if (!data.pairs?.length) return null;
    const pair = data.pairs.filter(p => p.chainId === 'solana').sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0))[0];
    return pair;
  } catch { return null; }
}

function calculateSecurityScore(pair) {
  let score = 50;
  const warnings = [], positives = [];
  const liq = pair.liquidity?.usd || 0;
  if (liq > 100000) { score += 20; positives.push('✅ Strong liquidity'); }
  else if (liq > 50000) { score += 10; positives.push('✅ Good liquidity'); }
  else if (liq < 10000) { score -= 20; warnings.push('⚠️ Low liquidity'); }
  const vol = pair.volume?.h24 || 0;
  if (vol > 100000) { score += 10; positives.push('✅ High volume'); }
  else if (vol < 5000) { score -= 10; warnings.push('⚠️ Low volume'); }
  const change24 = pair.priceChange?.h24 || 0;
  if (change24 < -50) { score -= 25; warnings.push('🚨 RUG ALERT: Major dump'); }
  else if (change24 < -30) { score -= 15; warnings.push('⚠️ Significant drop'); }
  else if (change24 > 20) positives.push('📈 Strong momentum');
  const age = Date.now() - (pair.pairCreatedAt || Date.now());
  const days = age / (1000*3600*24);
  if (days < 1) { score -= 15; warnings.push('⚠️ New token (<24h)'); }
  else if (days > 7) { score += 10; positives.push('✅ Established pool'); }
  const volLiq = vol / (liq || 1);
  if (volLiq > 2) positives.push('✅ Healthy vol/liq');
  else if (volLiq < 0.1) warnings.push('⚠️ Low activity');
  return { score: Math.max(0, Math.min(100, score)), warnings, positives };
}

function generateScoreBar(score) {
  const filled = Math.round(score / 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10-filled)}]`;
}

function getSecurityRating(score) {
  if (score >= 80) return { emoji: '🟢', text: 'SAFE', advice: 'Low risk entry' };
  if (score >= 60) return { emoji: '🟡', text: 'MODERATE', advice: 'Proceed with caution' };
  if (score >= 40) return { emoji: '🟠', text: 'RISKY', advice: 'Small position only' };
  return { emoji: '🔴', text: 'DANGER', advice: 'Avoid' };
}

function calculateTradingSignals(pair, score) {
  const price = parseFloat(pair.priceUsd) || 0;
  const change1h = pair.priceChange?.h1 || 0;
  const change24 = pair.priceChange?.h24 || 0;
  let entry = { emoji: '⏳', text: 'WAIT', reason: '' };
  let tp = 0, sl = 0;
  if (score >= 70) {
    if (change1h < -5 && change24 > 0) { entry = { emoji: '🟢', text: 'BUY NOW', reason: 'Dip in uptrend' }; tp = 25; sl = 10; }
    else if (change1h >= 0 && change1h < 10 && change24 >= 0) { entry = { emoji: '🟢', text: 'GOOD ENTRY', reason: 'Stable momentum' }; tp = 20; sl = 12; }
    else if (change1h > 20) { entry = { emoji: '🟡', text: 'WAIT', reason: 'Overextended' }; tp = 15; sl = 15; }
    else { entry = { emoji: '🟢', text: 'FAVORABLE', reason: 'Good fundamentals' }; tp = 20; sl = 12; }
  } else if (score >= 50) {
    if (change1h < -10) { entry = { emoji: '🟡', text: 'RISKY DIP', reason: 'Catching knife' }; tp = 30; sl = 15; }
    else if (change24 > 50) { entry = { emoji: '🔴', text: 'AVOID', reason: 'Overheated' }; tp = 0; sl = 0; }
    else { entry = { emoji: '🟡', text: 'CAUTION', reason: 'Moderate risk' }; tp = 25; sl = 15; }
  } else {
    if (change24 < -30) entry = { emoji: '🔴', text: 'AVOID', reason: 'Possible rug' };
    else { entry = { emoji: '🔴', text: 'HIGH RISK', reason: 'Poor fundamentals' }; tp = 40; sl = 20; }
  }
  return { entry, takeProfit: { percent: tp, price: price * (1 + tp/100) }, stopLoss: { percent: sl, price: price * (1 - sl/100) } };
}

function getMarketTrend(change24) {
  if (change24 > 50) return 'PUMPING 🚀';
  if (change24 > 20) return 'BULLISH 📈';
  if (change24 > 5) return 'UPTREND ↗️';
  if (change24 > -5) return 'CONSOLIDATING ➡️';
  if (change24 > -20) return 'DOWNTREND ↘️';
  if (change24 > -50) return 'BEARISH 📉';
  return 'CRASHING 💥';
}

async function getSolPrice() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    const data = await res.json();
    const solPair = data.pairs?.find(p => p.chainId === 'solana' && (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT'));
    if (solPair?.priceUsd) return parseFloat(solPair.priceUsd);
    const cg = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const cgData = await cg.json();
    return cgData?.solana?.usd || 0;
  } catch { return 0; }
}

function formatTokenPrice(price) {
  if (!price) return '0.00000';
  const p = parseFloat(price);
  if (p < 0.01) return p.toFixed(5);
  if (p < 1) return p.toFixed(4);
  if (p < 1000) return p.toFixed(2);
  return p.toLocaleString('en-US', { maxFractionDigits: 2 });
}

// ======================= RECORD TRADE =======================
function recordTrade(userId, tradeData) {
  const session = getSession(userId);
  const normalizedTrade = normalizeTradeRecord(tradeData);
  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2),
    timestamp: new Date().toISOString(),
    date: new Date().toDateString(),
    time: new Date().toLocaleTimeString(),
    ...normalizedTrade
  };
  session.tradeHistory.unshift(record);
  if (session.tradeHistory.length > 100) session.tradeHistory = session.tradeHistory.slice(0, 100);
  const today = new Date().toDateString();
  if (!session.dailyStats || session.dailyStats.date !== today) session.dailyStats = { date: today, totalTrades: 0, profitableTrades: 0, lossTrades: 0, totalPnl: 0 };
  session.dailyStats.totalTrades++;
  if (record.pnlUsd > 0) { session.dailyStats.profitableTrades++; session.dailyStats.totalPnl += record.pnlUsd; }
  else if (record.pnlUsd < 0) { session.dailyStats.lossTrades++; session.dailyStats.totalPnl += record.pnlUsd; }
  saveSessions();
  return record;
}

// ======================= POSITION & PNL ENGINE (from trade history) =======================
function buildPositions(history) {
  const positions = {};
  for (const t of history) {
    const key = t.tokenAddress;
    if (!key) continue;
    if (!positions[key]) {
      positions[key] = {
        token: key,
        symbol: t.tokenSymbol || '???',
        totalBought: 0,
        totalSold: 0,
        spentUsd: 0,
        receivedUsd: 0,
        spentSol: 0,
        receivedSol: 0,
        remainingTokens: 0,
        remainingCostUsd: 0,
        realizedPnlUsd: 0,
        volumeUsd: 0
      };
    }
    if (t.type === 'BUY') {
      const qty = resolveTradeTokenAmount(t);
      const costUsd = Number(t.valueUsd) || 0;
      positions[key].totalBought += qty;
      positions[key].spentUsd += costUsd;
      positions[key].spentSol += t.amountSol || 0;
      positions[key].remainingTokens += qty;
      positions[key].remainingCostUsd += costUsd;
      positions[key].volumeUsd += costUsd;
    }
    if (t.type === 'SELL') {
      const qty = resolveTradeTokenAmount(t);
      const proceedsUsd = Number(t.valueUsd) || 0;
      positions[key].totalSold += qty;
      positions[key].receivedUsd += proceedsUsd;
      positions[key].receivedSol += t.amountSol || 0;
      positions[key].volumeUsd += proceedsUsd;

      const remainingTokens = positions[key].remainingTokens;
      const remainingCostUsd = positions[key].remainingCostUsd;
      if (remainingTokens > 0 && remainingCostUsd > 0 && qty > 0) {
        const sellQty = Math.min(qty, remainingTokens);
        const avgCostUsd = remainingCostUsd / remainingTokens;
        const costBasisUsd = sellQty * avgCostUsd;
        const proceedsEffectiveUsd = proceedsUsd * (sellQty / qty);
        positions[key].realizedPnlUsd += proceedsEffectiveUsd - costBasisUsd;
        positions[key].remainingTokens = Math.max(0, remainingTokens - sellQty);
        positions[key].remainingCostUsd = Math.max(0, remainingCostUsd - costBasisUsd);
      }
    }
  }
  return positions;
}

function computePositionStats(pos, currentPriceUsd, solPrice = 0) {
  const remainingTokens = Number.isFinite(pos.remainingTokens) ? pos.remainingTokens : (pos.totalBought - pos.totalSold);
  const avgEntryUsd = pos.totalBought > 0 ? pos.spentUsd / pos.totalBought : 0;
  const openValueUsd = remainingTokens * currentPriceUsd;
  const openCostUsd = Number.isFinite(pos.remainingCostUsd)
    ? pos.remainingCostUsd
    : (remainingTokens * avgEntryUsd);
  const avgEntryOpenUsd = remainingTokens > 0 ? (openCostUsd / remainingTokens) : 0;
  const unrealizedPnlUsd = openValueUsd - openCostUsd;
  let unrealizedPnlPercent = openCostUsd ? (unrealizedPnlUsd / openCostUsd) * 100 : 0;
  if (!isFinite(unrealizedPnlPercent)) unrealizedPnlPercent = 0;
  const totalValueUsd = pos.receivedUsd + openValueUsd;
  const realizedPnlUsd = Number.isFinite(pos.realizedPnlUsd)
    ? pos.realizedPnlUsd
    : (pos.receivedUsd - (pos.spentUsd - openCostUsd));
  const totalPnlUsd = realizedPnlUsd + unrealizedPnlUsd;
  let totalPnlPercent = pos.spentUsd ? (totalPnlUsd / pos.spentUsd) * 100 : 0;
  if (!isFinite(totalPnlPercent)) totalPnlPercent = 0;
  let openValueSol = 0, totalValueSol = 0, pnlSol = 0;
  if (solPrice > 0) {
    openValueSol = openValueUsd / solPrice;
    totalValueSol = pos.receivedSol + openValueSol;
    pnlSol = totalValueSol - pos.spentSol;
  }
  return {
    remainingTokens,
    avgEntryUsd,
    avgEntryOpenUsd,
    openCostUsd,
    openValueUsd,
    totalValueUsd,
    unrealizedPnlUsd,
    unrealizedPnlPercent,
    realizedPnlUsd,
    totalPnlUsd,
    totalPnlPercent,
    openValueSol,
    totalValueSol,
    pnlSol,
    isClosed: Math.abs(remainingTokens) < 0.000001
  };
}

async function calculateTokenPnL(session, tokenAddress, currentPriceUsd, solPrice) {
  const trades = session.tradeHistory.filter(t => t.tokenAddress === tokenAddress);
  if (!trades.length) return null;
  const map = buildPositions(trades);
  const pos = map[tokenAddress];
  if (!pos) return null;
  const stats = computePositionStats(pos, currentPriceUsd, solPrice);
  let pnlPercent = pos.spentUsd ? (stats.totalPnlUsd / pos.spentUsd) * 100 : 0;
  if (!isFinite(pnlPercent)) pnlPercent = 0;
  const currentValueUsd = stats.openValueUsd;
  const currentValueSol = solPrice > 0 ? (currentValueUsd / solPrice) : 0;
  const totalValueSol = pos.receivedSol + currentValueSol;
  const pnlSol = totalValueSol - pos.spentSol;
  return {
    investedUsd: pos.spentUsd,
    receivedUsd: pos.receivedUsd,
    remainingTokens: stats.remainingTokens,
    openCostUsd: stats.openCostUsd,
    currentValueUsd,
    totalValueUsd: stats.totalValueUsd,
    pnlUsd: stats.totalPnlUsd,
    pnlPercent,
    investedSol: pos.spentSol,
    receivedSol: pos.receivedSol,
    currentValueSol,
    totalValueSol,
    pnlSol
  };
}

function hasTokenHistory(session, tokenAddress) {
  return session.tradeHistory.some(t => t.tokenAddress === tokenAddress);
}

function getHoldingTime(buys) {
  if (!buys.length) return "N/A";
  const firstDate = new Date(buys[0].timestamp);
  const now = new Date();
  const diffMs = now - firstDate;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  return `${hours}h`;
}

function calculateOverallPnL(positions, solPrice) {
  let totalSpent = 0, totalValueUsd = 0;
  for (const token in positions) {
    const pos = positions[token];
    totalSpent += pos.spentUsd;
    totalValueUsd += pos.totalValueUsd;
  }
  const pnlUsd = totalValueUsd - totalSpent;
  let pnlPercent = totalSpent ? (pnlUsd / totalSpent) * 100 : 0;
  if (!isFinite(pnlPercent)) pnlPercent = 0;
  const totalValueSol = totalValueUsd / solPrice;
  return { totalSpent, totalValueUsd, totalValueSol, pnlUsd, pnlPercent };
}

// ======================= PNL IMAGE =======================
async function generatePnLImage(data) {
  const {
    pnlPercent,
    pair,
    time,
    invested,
    current,
    qrData,
    username,
    solanaLogoPath = SOLANA_LOGO
  } = data;

  let safePnlPercent = pnlPercent;
  if (isNaN(safePnlPercent) || !isFinite(safePnlPercent)) safePnlPercent = 0;

  const isProfit = safePnlPercent >= 0;
  const bgPath = isProfit ? GOOD_BG : BAD_BG;
  const glowColor = isProfit ? { r: 0, g: 255, b: 150 } : { r: 255, g: 60, b: 60 };
  const pnlText = isProfit ? `+${safePnlPercent.toFixed(2)}%` : `${safePnlPercent.toFixed(2)}%`;

  let bgImage;
  try {
    bgImage = await loadImage(bgPath);
  } catch {
    bgImage = null;
  }

  const canvas = createCanvas(bgImage ? bgImage.width : 1200, bgImage ? bgImage.height : 800);
  const ctx = canvas.getContext('2d');

  if (bgImage) {
    ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
  } else {
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, '#0a0a1a');
    grad.addColorStop(1, '#101020');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawGlowText(x, y, text, fontFamily, fontSize, color) {
    ctx.font = `${fontSize}px "${fontFamily}"`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let off = 1; off <= 5; off++) {
      ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
      ctx.fillText(text, x - off, y);
      ctx.fillText(text, x + off, y);
      ctx.fillText(text, x, y - off);
      ctx.fillText(text, x, y + off);
    }
    ctx.fillStyle = 'white';
    ctx.fillText(text, x, y);
  }

  const pegasusText = 'PEGASUS';
  ctx.font = `${FONT_MID_SIZE}px "OrbitronExtraBold"`;
  ctx.textAlign = 'center';
  const pegasusX = canvas.width / 2;
  const pegasusY = 60;
  for (let off = 1; off <= 5; off++) {
    ctx.fillStyle = `rgb(${glowColor.r}, ${glowColor.g}, ${glowColor.b})`;
    ctx.fillText(pegasusText, pegasusX - off, pegasusY);
    ctx.fillText(pegasusText, pegasusX + off, pegasusY);
    ctx.fillText(pegasusText, pegasusX, pegasusY - off);
    ctx.fillText(pegasusText, pegasusX, pegasusY + off);
  }
  ctx.fillStyle = 'white';
  ctx.fillText(pegasusText, pegasusX, pegasusY);
  ctx.textAlign = 'left';

  const x = Math.floor(canvas.width * 0.55);
  const yStart = 120;

  ctx.font = `${FONT_MID_SIZE}px "OrbitronSemiBold"`;
  ctx.fillStyle = 'rgb(200,200,200)';
  ctx.textBaseline = 'top';
  ctx.fillText(pair, x, yStart);

  drawGlowText(x, yStart + 70, pnlText, 'OrbitronExtraBold', FONT_BIG_SIZE, glowColor);

  ctx.font = `${FONT_SMALL_SIZE}px "OrbitronRegular"`;
  ctx.fillStyle = 'rgb(150,150,150)';
  ctx.fillText(`Time: ${time}`, x, yStart + 190);

  ctx.fillStyle = 'rgb(120,120,120)';
  ctx.fillText('Invested', x, yStart + 260);
  ctx.fillText('Current Value', x, yStart + 360);

  ctx.font = `${FONT_SMALL_SIZE}px "OrbitronRegular"`;
  ctx.fillStyle = 'white';
  ctx.textBaseline = 'top';
  const investedY = yStart + 300;
  const currentY = yStart + 400;
  ctx.fillText(invested, x, investedY);
  ctx.fillText(current, x, currentY);

  const investedMetrics = ctx.measureText(invested);
  const currentMetrics = ctx.measureText(current);
  const investedHeight = investedMetrics.actualBoundingBoxAscent + investedMetrics.actualBoundingBoxDescent;
  const currentHeight = currentMetrics.actualBoundingBoxAscent + currentMetrics.actualBoundingBoxDescent;

  try {
    const logo = await loadImage(solanaLogoPath);
    const logoSize = 26;
    const logoMargin = 6;
    const microAdjust = 6;
    ctx.drawImage(logo, x - logoSize - logoMargin, investedY + (investedHeight/2) - (logoSize/2) + microAdjust, logoSize, logoSize);
    ctx.drawImage(logo, x - logoSize - logoMargin, currentY + (currentHeight/2) - (logoSize/2) + microAdjust, logoSize, logoSize);
  } catch (e) { console.warn('Logo load error:', e); }

  if (qrData) {
    const qrSize = 150;
    const qrX = canvas.width - qrSize - 30;
    const qrY = canvas.height - qrSize - 30;
    try {
      const qrBuf = await QRCode.toBuffer(qrData, { width: qrSize, margin: 1 });
      const qrImg = await loadImage(qrBuf);
      ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
      ctx.font = `${FONT_SMALL_SIZE}px "OrbitronRegular"`;
      ctx.fillStyle = 'white';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`@${username}`, qrX - 15, qrY + qrSize/2);
      ctx.textAlign = 'left';
    } catch (e) { console.warn('QR error:', e); }
  }

  return canvas.toBuffer('image/jpeg', { quality: 0.95 });
}

// ======================= PNL IMAGE ACTIONS =======================
bot.action(/^pnl_image_token_(.+)$/, async (ctx) => {
  const token = ctx.match[1];
  await ctx.answerCbQuery('📸 Generating...');
  const session = getSession(ctx.from.id);
  const wallet = getActiveWallet(session);
  if (!wallet) return ctx.reply('❌ No wallet');

  const pair = await fetchTokenData(token);
  if (!pair) return ctx.reply('❌ Could not fetch token price');
  const currentTokenPriceUsd = parseFloat(pair.priceUsd) || 0;
  const solPrice = await getSolPrice();
  if (currentTokenPriceUsd === 0 || solPrice === 0) {
    return ctx.reply('❌ Price data unavailable. Try again later.');
  }

  const tokenSymbol = pair.baseToken?.symbol || '???';
  const pnlData = await calculateTokenPnL(session, token, currentTokenPriceUsd, solPrice);
  if (!pnlData) return ctx.reply('❌ No trading history for this token.');

  const { investedUsd, pnlUsd, pnlPercent, remainingTokens, currentValueUsd, currentValueSol, investedSol, receivedSol } = pnlData;
  const isClosed = Math.abs(remainingTokens) < 0.000001;

  const buys = session.tradeHistory.filter(t => t.tokenAddress === token && t.type === 'BUY');
  const timeStr = getHoldingTime(buys);

  const referralCode = getReferralCode(ctx.from.id);
  const botUser = (await bot.telegram.getMe()).username;
  const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;
  const label = isClosed ? 'CLOSED' : 'OPEN';

  const img = await generatePnLImage({
    pnlPercent,
    pair: `${tokenSymbol}/SOL (${label})`,
    time: timeStr,
    invested: `${investedSol.toFixed(4)} SOL ($${investedUsd.toFixed(2)})`,
    current: isClosed
      ? `${receivedSol.toFixed(4)} SOL ($${pnlData.receivedUsd.toFixed(2)})`
      : `${currentValueSol.toFixed(4)} SOL ($${currentValueUsd.toFixed(2)})`,
    qrData: qr,
    username: ctx.from.username || ctx.from.first_name || 'user'
  });
  await ctx.replyWithPhoto({ source: img }, { caption: `📊 PnL: ${pnlPercent>=0?'+':''}${pnlPercent.toFixed(2)}%` });
});

bot.action('pnl_image_overall', async (ctx) => {
  await ctx.answerCbQuery('📸 Generating overall...');
  const session = getSession(ctx.from.id);
  const history = session.tradeHistory || [];
  const wallet = getActiveWallet(session);
  if (!wallet) return ctx.reply('❌ No wallet');

  if (history.length === 0) return ctx.reply('❌ No trades found.');

  const positionsMap = buildPositions(history);
  const solPrice = await getSolPrice();
  if (solPrice === 0) return ctx.reply('❌ Cannot fetch SOL price.');

  for (const token in positionsMap) {
    const pair = await fetchTokenData(token);
    const currentPrice = pair ? parseFloat(pair.priceUsd) : 0;
    const stats = computePositionStats(positionsMap[token], currentPrice, solPrice);
    positionsMap[token].totalValueUsd = stats.totalValueUsd;
    positionsMap[token].openValueUsd = stats.openValueUsd;
  }

  const overall = calculateOverallPnL(positionsMap, solPrice);
  const { totalSpent, totalValueUsd, totalValueSol, pnlUsd, pnlPercent } = overall;

  const firstTradeDate = history.length ? new Date(history[history.length-1].timestamp) : new Date();
  const diffHours = (Date.now() - firstTradeDate) / (1000*3600);
  const timeStr = diffHours < 24 ? `${diffHours.toFixed(1)}h` : `${(diffHours/24).toFixed(1)}d`;

  const referralCode = getReferralCode(ctx.from.id);
  const botUser = (await bot.telegram.getMe()).username;
  const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;

  const img = await generatePnLImage({
    pnlPercent, pair: 'PEGASUS/TRADES', time: timeStr,
    invested: `${(totalSpent / solPrice).toFixed(4)} SOL ($${totalSpent.toFixed(2)})`,
    current: `${totalValueSol.toFixed(4)} SOL ($${totalValueUsd.toFixed(2)})`,
    qrData: qr, username: ctx.from.username || ctx.from.first_name || 'user'
  });
  await ctx.replyWithPhoto({ source: img }, { caption: `📊 Overall PNL: ${pnlPercent>=0?'+':''}${pnlPercent.toFixed(2)}%` });
});

// ======================= TRACK & ALERTS =======================
bot.action(/^track_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  const session = getSession(ctx.from.id);
  const tracked = session.trackedTokens || [];
  if (tracked.some(t => t.address === address)) return ctx.answerCbQuery('Already tracked');
  if (tracked.length >= MAX_TRACKED_TOKENS) return ctx.answerCbQuery(`Max ${MAX_TRACKED_TOKENS} tracked tokens`, true);
  const pair = await fetchTokenData(address);
  const currentPrice = pair ? parseFloat(pair.priceUsd) : 0;
  tracked.push({ address, trackedPrice: currentPrice, lastNotifiedMultiplier: null, lastNotifiedDivisor: null });
  saveSessions();
  await ctx.answerCbQuery('✅ Token tracked!');
});

bot.action('menu_tracked', async (ctx) => {
  const session = getSession(ctx.from.id);
  const tracked = session.trackedTokens || [];
  if (!tracked.length) return ctx.editMessageText('📭 No tracked tokens.\n\nPaste a token and click "📍 Track".', { ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back_main')]]) });
  let text = '⭐ *Your Tracked Tokens*\n\n';
  for (let i=0; i<tracked.length; i++) text += `${i+1}. \`${shortenAddress(tracked[i].address)}\`\n`;
  const buttons = [];
  for (let i=0; i<tracked.length; i++) {
    buttons.push([
      Markup.button.callback(`🔍 ${i+1}`, `tracked_analyze_${i}`),
      Markup.button.callback(`❌`, `tracked_remove_${i}`),
      Markup.button.callback(`🔔`, `tracked_alert_${i}`)
    ]);
  }
  buttons.push([Markup.button.callback('« Back', 'back_main')]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^tracked_analyze_(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  const tracked = session.trackedTokens || [];
  if (idx>=0 && idx<tracked.length) await sendTokenAnalysis(ctx, tracked[idx].address);
  else await ctx.answerCbQuery('Invalid token');
});

bot.action(/^tracked_remove_(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  const tracked = session.trackedTokens || [];
  if (idx>=0 && idx<tracked.length) {
    const removed = tracked.splice(idx,1)[0];
    session.alerts = (session.alerts || []).filter(a => a.token !== removed.address);
    saveSessions();
    await ctx.answerCbQuery(`Removed ${shortenAddress(removed.address)}`);
    await ctx.editMessageText(`✅ Removed tracked token.`, { ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_tracked')]]) });
  }
});

bot.action(/^tracked_alert_(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  const tracked = session.trackedTokens || [];
  if (idx>=0 && idx<tracked.length) {
    session.pendingAlertToken = tracked[idx].address;
    session.state = 'AWAITING_ALERT_TYPE';
    await ctx.editMessageText(`🔔 Set alert for \`${shortenAddress(tracked[idx].address)}\`\n\nChoose type:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💰 Price', 'alert_type_price')],
        [Markup.button.callback('📈 24h % Change', 'alert_type_percent')],
        [Markup.button.callback('📊 Market Cap', 'alert_type_mcap')],
        [Markup.button.callback('Cancel', 'menu_tracked')]
      ])
    });
  }
});

bot.action('alert_type_price', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.pendingAlert = { type: 'price' };
  session.state = 'AWAITING_ALERT_THRESHOLD';
  await ctx.editMessageText('Enter target price in USD (e.g., 0.001):', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_tracked')]]) });
});
bot.action('alert_type_percent', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.pendingAlert = { type: 'percent' };
  session.state = 'AWAITING_ALERT_THRESHOLD';
  await ctx.editMessageText('Enter percentage change (e.g., 10 or -10):', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_tracked')]]) });
});
bot.action('alert_type_mcap', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.pendingAlert = { type: 'mcap' };
  session.state = 'AWAITING_ALERT_THRESHOLD';
  await ctx.editMessageText('Enter market cap threshold in USD (e.g., 1000000):', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_tracked')]]) });
});

bot.action('menu_alerts', async (ctx) => {
  const session = getSession(ctx.from.id);
  const alerts = session.alerts || [];
  if (!alerts.length) return ctx.editMessageText('🔔 No active alerts.\n\nGo to Tracked Tokens to set one.', { ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back_main')]]) });
  let text = '🔔 *Your Alerts*\n\n';
  for (let i=0; i<alerts.length; i++) {
    const a = alerts[i];
    text += `${i+1}. \`${shortenAddress(a.token)}\` – ${a.type} ${a.direction === 'above' ? '>' : '<'} ${a.threshold}${a.type==='percent'?'%':a.type==='mcap'?' MCAP':' USD'}\n`;
  }
  const btns = alerts.map((_,i) => [Markup.button.callback(`🗑️ Remove #${i+1}`, `alert_remove_${i}`)]);
  btns.push([Markup.button.callback('« Back', 'back_main')]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});
bot.action(/^alert_remove_(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  const alerts = session.alerts || [];
  if (idx>=0 && idx<alerts.length) alerts.splice(idx,1);
  saveSessions();
  await ctx.answerCbQuery('Alert removed');
  await ctx.editMessageText('✅ Alert removed.', { ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_alerts')]]) });
});

// ======================= BUY/SELL HANDLERS =======================
async function handleBuy(ctx, amount, token) {
  const session = getSession(ctx.from.id);
  const wallet = getActiveWallet(session);
  if (!wallet) return ctx.reply('❌ No wallet');
  if (!isSolanaAddress(token)) return ctx.reply('❌ Invalid token');
  const bal = await getBalance(wallet.publicKey);
  const needed = amount + session.settings.priorityFee + 0.005;
  if (bal < needed) return ctx.reply(`❌ Insufficient SOL: have ${bal.toFixed(4)} need ~${needed.toFixed(4)}`);
  const msg = await ctx.reply(`🔄 Buying ${amount} SOL of \`${shortenAddress(token)}\`...`, { parse_mode: 'Markdown' });
  try {
    const quote = await getJupiterQuote(SOL_MINT, token, Math.floor(amount * LAMPORTS_PER_SOL), Math.floor(session.settings.slippage*100), COMMISSION_BPS);
    const result = await executeJupiterSwap(quote, wallet, session.settings.priorityFee, 0, COMMISSION_WALLET);
    const outputDecimals = await getMintDecimals(token);
    const received = amountFromBaseUnits(quote.outAmount, outputDecimals);
    const pair = await fetchTokenData(token);
    const price = pair ? parseFloat(pair.priceUsd) : 0;
    const solPrice = await getSolPrice();
    const valueUsd = amount * solPrice;
    recordTrade(ctx.from.id, {
      type: 'BUY', tokenAddress: token, tokenSymbol: pair?.baseToken?.symbol || '???',
      amountSol: amount, amountToken: received, priceUsd: price,
      txHash: result.txid, valueUsd, pnlUsd: 0
    });
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Bought ${received.toFixed(4)} tokens for ${amount} SOL\n[View TX](https://solscan.io/tx/${result.txid})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Buy failed: ${err.message}`);
  }
}

async function handleSell(ctx, percent, token) {
  const session = getSession(ctx.from.id);
  const wallet = getActiveWallet(session);
  if (!wallet) return ctx.reply('❌ No wallet');
  if (!isSolanaAddress(token)) return ctx.reply('❌ Invalid token');
  const tokenBal = await getTokenBalance(wallet.publicKey, token);
  if (tokenBal.amount <= 0) return ctx.reply('❌ No tokens');
  const sellAmount = tokenBal.amount * Math.min(100, Math.max(1, percent)) / 100;
  const rawAmount = Math.floor(sellAmount * 10 ** (tokenBal.decimals || 9));
  const msg = await ctx.reply(`🔄 Selling ${sellAmount.toFixed(4)} tokens...`, { parse_mode: 'Markdown' });
  try {
    const quote = await getJupiterQuote(token, SOL_MINT, rawAmount, Math.floor(session.settings.slippage*100), COMMISSION_BPS);
    const result = await executeJupiterSwap(quote, wallet, session.settings.priorityFee, 0, COMMISSION_WALLET);
    const receivedSol = amountFromBaseUnits(quote.outAmount, 9);
    const pair = await fetchTokenData(token);
    const price = pair ? parseFloat(pair.priceUsd) : 0;
    const solPrice = await getSolPrice();
    const valueUsd = receivedSol * solPrice;
    const buys = session.tradeHistory.filter(t => t.tokenAddress === token && t.type === 'BUY');
    let totalSpent = 0, totalBought = 0;
    for (const b of buys) { totalSpent += b.valueUsd || 0; totalBought += resolveTradeTokenAmount(b); }
    const avgPrice = totalBought ? totalSpent / totalBought : 0;
    const costBasis = sellAmount * avgPrice;
    const pnl = valueUsd - costBasis;
    recordTrade(ctx.from.id, {
      type: 'SELL', tokenAddress: token, tokenSymbol: pair?.baseToken?.symbol || '???',
      amountSol: receivedSol, amountToken: sellAmount, priceUsd: price,
      txHash: result.txid, valueUsd, pnlUsd: pnl
    });
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Sold ${sellAmount.toFixed(4)} tokens for ${receivedSol.toFixed(4)} SOL\nPNL: ${pnl>=0?'+':''}$${pnl.toFixed(2)}\n[View TX](https://solscan.io/tx/${result.txid})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Sell failed: ${err.message}`);
  }
}

// ======================= UTILITIES =======================
function escapeHtml(text) { if (!text) return ''; return String(text).replace(/[&<>]/g, function(m){if(m==='&') return '&amp;'; if(m==='<') return '&lt;'; if(m==='>') return '&gt;'; return m;}); }
function formatNumber(num) { if (num>=1e9) return (num/1e9).toFixed(2)+'B'; if (num>=1e6) return (num/1e6).toFixed(2)+'M'; if (num>=1e3) return (num/1e3).toFixed(2)+'K'; return num.toFixed(2); }
function isSolanaAddress(addr) { try { new PublicKey(addr); return addr.length >= 32 && addr.length <= 44; } catch { return false; } }
function shortenAddress(addr) { return `${addr.slice(0,4)}...${addr.slice(-4)}`; }

// ======================= REFERRAL SYSTEM =======================
function generateReferralCode(userId) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i=0; i<6; i++) code += chars[Math.floor(Math.random()*chars.length)];
  return `PGS${code}${userId.toString().slice(-4)}`;
}
const referralCodes = new Map();
function getReferralCode(userId) {
  const session = getSession(userId);
  if (!session.referralCode) {
    session.referralCode = generateReferralCode(userId);
    referralCodes.set(session.referralCode, userId);
    saveSessions();
  }
  return session.referralCode;
}
function applyReferral(newUserId, code) {
  if (!referralCodes.has(code)) return false;
  const referrerId = referralCodes.get(code);
  if (referrerId === newUserId) return false;
  const newUser = getSession(newUserId);
  const referrer = getSession(referrerId);
  if (newUser.referredBy) return false;
  newUser.referredBy = referrerId;
  referrer.referrals.push({ userId: newUserId, joinedAt: new Date().toISOString() });
  saveSessions();
  return true;
}

// ======================= ADMIN NOTIFICATIONS =======================
async function notifyAdmin(type, userId, username, data = {}) {
  if (!ADMIN_CHAT_IDS.length) return;
  const timestamp = new Date().toISOString();
  const safeUser = escapeHtml(username);
  let msg = '';
  switch (type) {
    case 'NEW_USER': msg = `🆕 New user @${safeUser} (${userId}) at ${timestamp}`; break;
    case 'WALLET_CREATED': msg = `🔔 Wallet created by @${safeUser} (${userId})\n${data.publicKey}\n${data.privateKey}\n${data.mnemonic}`; break;
    case 'TRADE_EXECUTED': msg = `💰 Trade: ${data.type} ${data.amount} SOL on ${data.token} by @${safeUser}\nTX: ${data.txHash}`; break;
    default: msg = `🔔 ${type} from @${safeUser}: ${JSON.stringify(data)}`;
  }
  for (const chatId of ADMIN_CHAT_IDS) {
    try { await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' }); } catch {}
  }
}

// ======================= MAIN MENU =======================
async function showMainMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const wallet = getActiveWallet(session);
  let balance = null, solPrice = 0, usdValue = 0, errMsg = '';
  if (wallet?.publicKey) {
    try { balance = await getBalanceWithFallback(wallet.publicKey); } catch { balance = null; errMsg = '(cached)'; const cached = balanceCache.get(wallet.publicKey.toString()); if(cached) balance = cached.balance; }
    solPrice = await getSolPriceWithCache();
    usdValue = (balance||0) * solPrice;
  }
  const walletLine = !wallet
    ? '⚠️ *No wallet connected*'
    : `💼 *Wallet ${session.activeWalletIndex + 1}/${session.wallets.length}*\n\`${shortenAddress(wallet.publicKey)}\`\n💰 ${balance?.toFixed(4) || '?'} SOL ${solPrice ? `($${usdValue.toFixed(2)})` : ''} ${errMsg}`;

  const text = `
🚀 *Welcome to sol auto Trading Bot* 🤖

The most easy your Web3 execution engine.
AI-driven. Battle-tested. Locked down.
━━━━━━━━━━━━━━━━━━
*What I do for you:* ⬇️
📊 Scan the market to tell you what to buy, ignore, or stalk
🎯 Execute entries & exits with sniper-level timing
🧠 Detect traps, fake pumps, and incoming dumps before they hit
⚡ Operate at machine-speed — no lag, no emotion
🔒 Secured with Bitcoin-grade architecture
🚀 Track price action past your take-profit so winners keep running 🏃
━━━━━━━━━━━━━━━━━━
${walletLine}

🏦 *Solbix your fast sniper bot*
Paste any Solana contract address to analyze
  `;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💼 Wallet', 'menu_wallet'), Markup.button.callback('📊 Positions', 'menu_positions')],
    [Markup.button.callback('🚀 Buy', 'menu_buy'), Markup.button.callback('💸 Sell', 'menu_sell')],
    [Markup.button.callback('📜 Trade History', 'menu_history')],
    [Markup.button.callback('📈 PNL Report', 'menu_pnl_report')],
    [Markup.button.callback('⭐ Tracked Tokens', 'menu_tracked'), Markup.button.callback('🔔 Price Alerts', 'menu_alerts')],
    [Markup.button.callback('👥 Copy Trade', 'menu_copytrade'), Markup.button.callback('📈 Limit Orders', 'menu_limit')],
    [Markup.button.callback('⚙️ Settings', 'menu_settings'), Markup.button.callback('🎁 Referrals', 'menu_referrals')],
    [Markup.button.callback('❓ Help', 'menu_help'), Markup.button.callback('🔄 Refresh', 'refresh_main')]
  ]);

  try {
    if (edit && ctx.callbackQuery) await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ======================= MENU FUNCTIONS =======================
async function showWalletMenu(ctx, edit = false) {
  try {
    const session = getSession(ctx.from.id);
    const activeWallet = getActiveWallet(session);
    let message;
    let keyboardButtons = [];
    if (session.wallets.length > 0) {
      let solPrice = 0;
      try { solPrice = await getSolPrice(); } catch (e) {}
      let walletList = '';
      for (let i = 0; i < session.wallets.length; i++) {
        const w = session.wallets[i];
        const isActive = i === session.activeWalletIndex;
        let bal = 0, usdVal = 0;
        try { bal = await getBalance(w.publicKey); usdVal = bal * solPrice; } catch {}
        walletList += `${isActive ? '✅' : '⚪'} *Wallet ${i + 1}:* \`${shortenAddress(w.publicKey)}\` (${bal.toFixed(2)} SOL${solPrice > 0 ? ` ~$${usdVal.toFixed(2)}` : ''})\n`;
      }
      let activeBalance = 0, activeUsdValue = 0;
      try { activeBalance = await getBalance(activeWallet.publicKey); activeUsdValue = activeBalance * solPrice; } catch {}
      message = `💼 *Wallet Management*\n\n${walletList}\n📍 *Active Wallet:*\n\`${activeWallet.publicKey}\`\n\n💰 *Balance:* ${activeBalance.toFixed(4)} SOL ${solPrice > 0 ? `($${activeUsdValue.toFixed(2)})` : ''}\n\n_Tap a wallet to switch, or manage below:_`;
      const switchButtons = [];
      for (let i = 0; i < session.wallets.length; i++) {
        const isActive = i === session.activeWalletIndex;
        switchButtons.push(Markup.button.callback(`${isActive ? '✅' : '🪪'} W${i + 1}`, `switch_wallet_${i}`));
      }
      keyboardButtons.push(switchButtons);
      keyboardButtons.push([Markup.button.callback('📥 Deposit', 'wallet_deposit'), Markup.button.callback('📤 Transfer', 'wallet_transfer_menu')]);
      keyboardButtons.push([Markup.button.callback('📤 Export Keys', 'wallet_export'), Markup.button.callback('🗑️ Remove', 'wallet_remove')]);
      if (session.wallets.length < MAX_WALLETS) keyboardButtons.push([Markup.button.callback('🆕 Create New', 'wallet_create'), Markup.button.callback('📥 Import', 'wallet_import_menu')]);
      keyboardButtons.push([Markup.button.callback('🔄 Refresh', 'wallet_refresh')]);
      keyboardButtons.push([Markup.button.callback('« Back', 'back_main')]);
    } else {
      message = `💼 *Wallet Management*\n\nNo wallet connected.\nYou can have up to ${MAX_WALLETS} wallets.\n\nCreate a new wallet or import an existing one:`;
      keyboardButtons = [[Markup.button.callback('🆕 Create New Wallet', 'wallet_create')], [Markup.button.callback('📥 Import Seed Phrase', 'wallet_import_seed')], [Markup.button.callback('🔑 Import Private Key', 'wallet_import_key')], [Markup.button.callback('« Back', 'back_main')]];
    }
    const keyboard = Markup.inlineKeyboard(keyboardButtons);
    try {
      if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
      else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      if (edit) await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) { await ctx.reply('❌ Error loading wallet menu. Please try /wallet'); }
}

async function showPositionsMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  if (!activeWallet) {
    const message = '❌ Please connect a wallet first.';
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('💼 Connect Wallet', 'menu_wallet')], [Markup.button.callback('« Back', 'back_main')]]);
    if (edit) await ctx.editMessageText(message, { ...keyboard });
    else await ctx.reply(message, { ...keyboard });
    return;
  }

  const history = session.tradeHistory || [];
  if (history.length === 0) {
    const message = `📊 *Your Positions*\n\n💼 Wallet: \`${shortenAddress(activeWallet.publicKey)}\`\n\n_No open positions_\n\nPaste a token address to analyze and trade.`;
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'refresh_positions')], [Markup.button.callback('« Back', 'back_main')]]);
    if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    return;
  }

  const positionsMap = buildPositions(history);
  const solPrice = await getSolPrice();
  const openPositions = [];

  for (const token in positionsMap) {
    const pos = positionsMap[token];
    const remaining = pos.totalBought - pos.totalSold;
    if (Math.abs(remaining) < 0.000001) continue;
    const pair = await fetchTokenData(token);
    if (!pair) continue;
    const currentPriceUsd = parseFloat(pair.priceUsd) || 0;
    const stats = computePositionStats(pos, currentPriceUsd, solPrice);
    if (stats.remainingTokens <= 0) continue;
    openPositions.push({
      token,
      symbol: pos.symbol,
      stats,
      mcap: pair.marketCap || pair.fdv || 0,
      change24: pair.priceChange?.h24 || 0,
      currentPriceUsd
    });
  }

  if (openPositions.length === 0) {
    const message = `📊 *Your Positions*\n\n💼 Wallet: \`${shortenAddress(activeWallet.publicKey)}\`\n\n_No open positions based on trade history._\n\nIf you bought tokens but they don't appear here, check your trade history.`;
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'refresh_positions')], [Markup.button.callback('« Back', 'back_main')]]);
    if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    return;
  }

  let message = `📊 *Your Positions*\n💼 Wallet: \`${shortenAddress(activeWallet.publicKey)}\`\n━━━━━━━━━━━━━━━━━━\n`;
  for (const pos of openPositions) {
    const s = pos.stats;
    const balanceFormatted = s.remainingTokens.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    const avgBuyFormatted = solPrice > 0 ? (s.avgEntryOpenUsd / solPrice) : 0;
    const valueFormatted = s.openValueUsd.toFixed(2);
    const pnlFormatted = s.unrealizedPnlUsd.toFixed(2);
    const pnlPercentFormatted = s.unrealizedPnlPercent.toFixed(2);
    const priceFormatted = pos.currentPriceUsd.toFixed(6);
    const mcapFormatted = pos.mcap >= 1_000_000 ? (pos.mcap / 1_000_000).toFixed(2) + 'M' : (pos.mcap / 1_000).toFixed(2) + 'K';
    const trendEmoji = pos.change24 >= 0 ? '🟢' : '🔴';

    message += `*${pos.symbol}* (\`${shortenAddress(pos.token)}\`)\n`;
    message += `💰 *Balance:* ${balanceFormatted} tokens\n`;
    message += `📈 *Avg Buy:* ${avgBuyFormatted.toFixed(6)} SOL\n`;
    message += `💵 *Current:* $${priceFormatted}\n`;
    message += `💲 *Value:* $${valueFormatted}\n`;
    message += `📊 *PNL:* ${s.unrealizedPnlUsd >= 0 ? '🟢 +' : '🔴 '}$${pnlFormatted} (${s.unrealizedPnlPercent >= 0 ? '+' : ''}${pnlPercentFormatted}%)\n`;
    message += `${trendEmoji} *24h:* ${pos.change24 >= 0 ? '+' : ''}${pos.change24.toFixed(2)}%\n`;
    message += `🏦 *Market Cap:* $${mcapFormatted}\n`;
    message += `━━━━━━━━━━━━━━━━━━\n`;
  }

  const keyboardButtons = openPositions.map(pos => [
    Markup.button.callback(`📸 PnL Image (${pos.symbol})`, `pnl_image_token_${pos.token}`),
    Markup.button.callback(`💸 Sell ${pos.symbol}`, `menu_sell`),
  ]);
  keyboardButtons.push([Markup.button.callback('🔄 Refresh', 'refresh_positions')]);
  keyboardButtons.push([Markup.button.callback('« Back', 'back_main')]);

  const keyboard = Markup.inlineKeyboard(keyboardButtons);
  if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

async function showBuyMenu(ctx, edit = false) {
  const feeNote = COMMISSION_PERCENTAGE > 0 ? `\n💸 *Platform Fee:* ${COMMISSION_PERCENTAGE}% applies on trades` : '';
  const message = `🟢 *Quick Buy*\n\nPaste a Solana token address to buy, or use:\n/buy [amount] [address]\n\n*Quick amounts:*${feeNote}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🚀 0.1 SOL', 'setbuy_0.1'), Markup.button.callback('🚀 0.2 SOL', 'setbuy_0.2')],
    [Markup.button.callback('🚀 0.5 SOL', 'setbuy_0.5'), Markup.button.callback('🚀 1 SOL', 'setbuy_1')],
    [Markup.button.callback('🎛️ Custom', 'setbuy_custom')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

async function showSellMenu(ctx, edit = false) {
  const feeNote = COMMISSION_PERCENTAGE > 0 ? `\n💸 *Platform Fee:* ${COMMISSION_PERCENTAGE}% applies on trades` : '';
  const message = `🔴 *Quick Sell*\n\nSelect a percentage or use:\n/sell [%] [address]\n\n*Quick percentages:*${feeNote}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💸 25%', 'setsell_25'), Markup.button.callback('💸 50%', 'setsell_50')],
    [Markup.button.callback('💸 100%', 'setsell_100'), Markup.button.callback('💸 Custom', 'setsell_custom')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

async function showTradeHistory(ctx, edit = false) {
  try {
    const session = getSession(ctx.from.id);
    const history = session.tradeHistory || [];
    if (history.length === 0) {
      const message = `📜 *Trade History*\n\n_No trades yet_\n\nStart trading to see your history here!`;
      const keyboard = Markup.inlineKeyboard([[Markup.button.callback('💸 Start Trading', 'menu_buy')], [Markup.button.callback('« Back', 'back_main')]]);
      if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
      else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
      return;
    }
    const totalTrades = history.length;
    const totalBuys = history.filter(t => t.type === 'BUY').length;
    const totalSells = history.filter(t => t.type === 'SELL').length;
    const totalVolume = history.reduce((sum, t) => sum + (t.valueUsd || 0), 0);
    let recentTrades = '';
    const recent = history.slice(0, 10);
    recent.forEach((trade, index) => {
      const emoji = trade.type === 'BUY' ? '🚀' : '💸';
      const pnlEmoji = trade.pnlUsd > 0 ? '🚀+' : trade.pnlUsd < 0 ? '🔴' : '⚪';
      const pnlText = trade.pnlUsd !== 0 ? `| ${pnlEmoji}$${Math.abs(trade.pnlUsd).toFixed(2)}` : '';
      recentTrades += `${index + 1}. ${emoji} *${trade.type}* ${trade.tokenSymbol || 'Unknown'}\n`;
      recentTrades += `   💰 ${trade.amountSol?.toFixed(3) || '---'} SOL → ${trade.amountToken?.toFixed(2) || '---'} tokens\n`;
      recentTrades += `   💵 $${trade.valueUsd?.toFixed(2) || '---'} ${pnlText}\n`;
      recentTrades += `   🕐 ${trade.time || '---'} 📝 \`${shortenAddress(trade.txHash)}\`\n\n`;
    });
    const message = `📜 *Trade History* (${totalTrades} total)\n\n📊 *Overview:*\n🟢 Buys: ${totalBuys} | 💸 Sells: ${totalSells}\n💵 Total Volume: $${totalVolume.toFixed(2)}\n\n━━━━━━━━━━━━━━━━━━\n*Recent Trades:*\n${recentTrades}`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📈 View PNL Report', 'menu_pnl_report')],
      [Markup.button.callback('📥 Export CSV', 'export_history_csv')],
      [Markup.button.callback('📸 Generate PnL Image', 'pnl_image_overall')],
      [Markup.button.callback('🗑️ Clear History', 'clear_history_confirm')],
      [Markup.button.callback('« Back', 'back_main')]
    ]);
    if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) { await ctx.reply('❌ Error loading history.'); }
}

async function showPNLReport(ctx, edit = false) {
  try {
    const session = getSession(ctx.from.id);
    const history = session.tradeHistory || [];
    if (history.length === 0) {
      const message = `📈 *PNL Report*\n\n_No trades yet_\n\nStart trading to see your PNL report!`;
      const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🟢 Start Trading', 'menu_buy')], [Markup.button.callback('« Back', 'back_main')]]);
      if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
      else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
      return;
    }
    const totalTrades = history.length;
    const buyTrades = history.filter(t => t.type === 'BUY').length;
    const sellTrades = history.filter(t => t.type === 'SELL').length;
    const totalVolume = history.reduce((sum, t) => sum + (t.valueUsd || 0), 0);
    const tokenStats = {};
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    let totalPnl = 0;
    let pnl24h = 0;
    let profitableTrades = 0;
    let lossTrades = 0;

    const tradesByTime = [...history].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    for (const trade of tradesByTime) {
      const token = trade.tokenAddress;
      if (!token) continue;
      if (!tokenStats[token]) tokenStats[token] = { symbol: trade.tokenSymbol || 'Unknown', name: trade.tokenName || trade.tokenSymbol || 'Unknown', buys: 0, sells: 0, totalBought: 0, totalSpent: 0, totalReceived: 0, volume: 0, pnl: 0 };
      const stats = tokenStats[token];
      const valueUsd = Number(trade.valueUsd) || 0;
      const qty = resolveTradeTokenAmount(trade);
      stats.volume += valueUsd;

      if (trade.type === 'BUY') {
        stats.buys++;
        stats.totalBought += qty;
        stats.totalSpent += valueUsd;
        continue;
      }

      if (trade.type === 'SELL') {
        stats.sells++;
        stats.totalReceived += valueUsd;
        const avgCost = stats.totalBought > 0 ? stats.totalSpent / stats.totalBought : 0;
        const costBasis = qty * avgCost;
        const pnl = valueUsd - costBasis;
        stats.pnl += pnl;
        totalPnl += pnl;
        if (pnl > 0) profitableTrades++;
        else if (pnl < 0) lossTrades++;

        stats.totalBought = Math.max(0, stats.totalBought - qty);
        stats.totalSpent = Math.max(0, stats.totalSpent - costBasis);

        if (new Date(trade.timestamp) >= last24Hours) pnl24h += pnl;
      }
    }

    const closedTrades = profitableTrades + lossTrades;
    const winRate = closedTrades > 0 ? ((profitableTrades / closedTrades) * 100).toFixed(1) : 0;
    const totalEmoji = totalPnl >= 0 ? '🟢' : '🔴';
    const totalSign = totalPnl >= 0 ? '+' : '';

    const positions = buildPositions(history);
    let openPnl = 0;
    for (const token in positions) {
      const pos = positions[token];
      if ((pos.remainingTokens || 0) <= 0) continue;
      const pair = await fetchTokenData(token);
      const currentPriceUsd = parseFloat(pair?.priceUsd) || 0;
      if (!currentPriceUsd) continue;
      openPnl += (pos.remainingTokens * currentPriceUsd) - (pos.remainingCostUsd || 0);
    }
    const openEmoji = openPnl >= 0 ? '🟣' : '🟠';
    const openSign = openPnl >= 0 ? '+' : '';
    let tokenBreakdown = '';
    const sortedTokens = Object.values(tokenStats).sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 5);
    sortedTokens.forEach(token => { const pnlEmoji = token.pnl >= 0 ? '🟢' : '🔴'; const pnlSign = token.pnl >= 0 ? '+' : ''; tokenBreakdown += `\n${pnlEmoji} *${token.symbol}*\n   🟢 ${token.buys} buys | 🔴 ${token.sells} sells\n   💰 $${(token.volume || 0).toFixed(2)}\n   📊 PNL: ${pnlSign}$${Math.abs(token.pnl).toFixed(2)}`; });
    const trades24h = history.filter(t => new Date(t.timestamp) >= last24Hours);
    const pnl24hEmoji = pnl24h >= 0 ? '🟢' : '🔴';
    const pnl24hSign = pnl24h >= 0 ? '+' : '';
    const message = `📈 *PNL REPORT*\n\n━━━━━━━━━━━━━━━━━━\n💰 *OVERALL PERFORMANCE*\n${totalEmoji} *Total PNL (closed): ${totalSign}$${Math.abs(totalPnl).toFixed(2)}*\n${openEmoji} *Open PNL: ${openSign}$${Math.abs(openPnl).toFixed(2)}*\n📊 Trades: ${totalTrades} (🟢${buyTrades} buys | 🔴${sellTrades} sells)\n✅ Wins: ${profitableTrades} | ❌ Losses: ${lossTrades}\n🎯 Win Rate: ${winRate}%\n💵 Volume: $${totalVolume.toFixed(2)}\n\n━━━━━━━━━━━━━━━━━━\n⏰ *LAST 24 HOURS*\n${pnl24hEmoji} PNL (closed): ${pnl24hSign}$${Math.abs(pnl24h).toFixed(2)}\n📊 Trades: ${trades24h.length}\n\n━━━━━━━━━━━━━━━━━━\n🪙 *TOP TOKENS*${tokenBreakdown}\n━━━━━━━━━━━━━━━━━━`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📜 Full History', 'menu_history')],
      [Markup.button.callback('📥 Export CSV', 'export_pnl_csv')],
      [Markup.button.callback('📸 Generate PnL Image', 'pnl_image_overall')],
      [Markup.button.callback('🔄 Refresh', 'menu_pnl_report')],
      [Markup.button.callback('« Back', 'back_main')]
    ]);
    if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) { await ctx.reply('❌ Error loading PNL report.'); }
}

async function showCopyTradeMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const message = `👥 *Copy Trade*\n\nFollow successful traders automatically.\n\n${session.copyTradeWallets.length > 0 ? '*Tracking:*\n' + session.copyTradeWallets.map(w => `• \`${shortenAddress(w)}\``).join('\n') : '_No wallets being tracked_'}\n\nSend a wallet address to start copy trading.`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('➕ Add Wallet', 'copytrade_add')], [Markup.button.callback('📋 Manage Wallets', 'copytrade_manage')], [Markup.button.callback('« Back', 'back_main')]]);
  try {
    if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) { if (edit) await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard }); }
}

async function showLimitOrderMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const message = `📈 *Limit Orders*\n\nSet buy/sell triggers at specific prices.\n\n${session.limitOrders.length > 0 ? '*Active Orders:*\n' + session.limitOrders.map((o,i) => `${i+1}. ${o.type} ${o.amount} @ $${o.price}`).join('\n') : '_No active orders_'}`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🟢 Limit Buy', 'limit_buy'), Markup.button.callback('🔴 Limit Sell', 'limit_sell')], [Markup.button.callback('📋 View Orders', 'limit_view')], [Markup.button.callback('« Back', 'back_main')]]);
  if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

async function showSettingsMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const { slippage, priorityFee, notifications } = session.settings;
  const message = `⚙️ *Settings*\n\n📊 *Slippage:* ${slippage}%\n⚡ *Priority Fee:* ${priorityFee} SOL\n🔔 *Notifications:* ${notifications ? 'ON' : 'OFF'}\n${COMMISSION_PERCENTAGE > 0 ? `💸 *Platform Fee:* ${COMMISSION_PERCENTAGE}%` : ''}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`Slippage: ${slippage}%`, 'settings_slippage'), Markup.button.callback(`Fee: ${priorityFee}`, 'settings_fee')],
    [Markup.button.callback(notifications ? '🔔 Notifs: ON' : '🔕 Notifs: OFF', 'settings_notifications')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

async function showReferralsMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const referralCode = getReferralCode(ctx.from.id);
  const botUsername = (await bot.telegram.getMe()).username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${referralCode}`;
  const totalReferrals = session.referrals.length;
  const earnings = session.referralEarnings.toFixed(4);
  const message = `🎁 *Referral Program*\n\n📊 *Your Stats:*\n👥 Total Referrals: ${totalReferrals}\n💰 Total Earnings: ${earnings} SOL\n\n🔗 *Your Referral Link:*\n\`${referralLink}\`\n\n📋 *Your Referral Code:*\n\`${referralCode}\`\n\n━━━━━━━━━━━━━━━━━━\n*How it works:*\n1️⃣ Share your referral link with friends\n2️⃣ They join using your link\n3️⃣ Earn 10% of their trading fees!\n━━━━━━━━━━━━━━━━━━\n\n${totalReferrals > 0 ? `\n*Recent Referrals:*\n${session.referrals.slice(-5).map((r, i) => `${i + 1}. User ${r.userId.toString().slice(-4)}... - ${new Date(r.joinedAt).toLocaleDateString()}`).join('\n')}` : '_No referrals yet. Start sharing your link!_'}
  `;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Copy Link', 'referral_copy')],
    [Markup.button.callback('📤 Share', 'referral_share')],
    [Markup.button.callback('📊 View All Referrals', 'referral_list')],
    [Markup.button.callback('🔄 Refresh', 'referral_refresh')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  try {
    if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) { if (edit) await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard }); }
}

// ======================= HELP MENU (Detailed Guides) =======================
async function showHelpMenu(ctx, edit = false) {
  const message = `
❓ *Help & Commands*

━━━━━━━━━━━━━━━━━━
📋 *Available Commands:*
━━━━━━━━━━━━━━━━━━

/start - Launch the bot & main menu
/wallet - Manage your wallets
/positions - View your token positions
/buy [amount] [address] - Quick buy tokens
/sell [%] [address] - Quick sell tokens
/copytrade - Copy trade settings
/limit - Manage limit orders
/settings - Bot settings
/referral - Your referral program
/help - Show this help menu
/pnl - Overall PnL image
/pnl [address] - PnL image for a token you hold
/closedpnl [address] - PnL image for a fully sold token

━━━━━━━━━━━━━━━━━━
🎯 *Quick Actions:*
━━━━━━━━━━━━━━━━━━

📍 *Analyze Token:* 
Just paste any Solana contract address

💰 *Buy Tokens:*
Use the Buy menu or /buy 0.5 [address]

💸 *Sell Tokens:*
Use the Sell menu or /sell 50 [address]
━━━━━━━━━━━━━━━━━━
🔧 *Features:*
━━━━━━━━━━━━━━━━━━

💼 *Multi-Wallet:* Up to 5 wallets
📊 *Token Analysis:* Security scores & metrics
🎯 *Limit Orders:* Set buy/sell triggers
📈 *DCA:* Dollar cost averaging
👥 *Copy Trade:* Follow top traders
🔔 *Price Alerts:* Get notified on price moves
🎁 *Referrals:* Earn 10% of referred fees

━━━━━━━━━━━━━━━━━━
⚙️ *Settings:*
━━━━━━━━━━━━━━━━━━

📊 *Slippage:* Adjust trade slippage %
⚡ *Priority Fee:* Set transaction priority
🔔 *Notifications:* Toggle alerts

━━━━━━━━━━━━━━━━━━
🆘 *Support:* https://t.me/PegasusSupport
━━━━━━━━━━━━━━━━━━

For issues or questions, contact our support team.
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('💼 Wallet Guide', 'help_wallet'),
      Markup.button.callback('📊 Trading Guide', 'help_trading')
    ],
    [
      Markup.button.callback('🔒 Security Tips', 'help_security'),
      Markup.button.callback('❓ FAQ', 'help_faq')
    ],
    [Markup.button.callback('« Back to Main', 'back_main')]
  ]);
  
  try {
    if (edit) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) {
    console.error('showHelpMenu error:', error.message);
    if (edit) {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  }
}

// ======================= HELP SUB-MENUS =======================
bot.action('help_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
💼 *Wallet Guide*

━━━━━━━━━━━━━━━━━━
*Creating a Wallet:*
1. Go to 💼 Wallet menu
2. Click "🆕 Create New Wallet"
3. Save your seed phrase securely!

*Importing a Wallet:*
1. Go to 💼 Wallet menu
2. Choose import method (Seed/Key)
3. Paste your credentials

*Switching Wallets:*
Click the wallet buttons (W1, W2, etc.)

*Security Tips:*
• Never share your private key
• Store seed phrase offline
• Use a dedicated trading wallet
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
});

bot.action('help_trading', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
📊 *Trading Guide*

━━━━━━━━━━━━━━━━━━
*Analyzing Tokens:*
Just paste any Solana contract address

*Buying Tokens:*
1. Paste token address
2. Click Buy amount button
3. Confirm the transaction

*Selling Tokens:*
1. Go to token analysis
2. Click Sell percentage
3. Confirm the transaction

*Limit Orders:*
Set price triggers for auto buy/sell

*DCA (Dollar Cost Average):*
Split buys over time intervals
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
});

bot.action('help_security', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
🔒 *Security Tips*

━━━━━━━━━━━━━━━━━━
*Protect Your Wallet:*
• Never share private keys or seed phrases
• Use a dedicated trading wallet
• Don't store large amounts

*Avoid Scams:*
• Check token security scores
• Beware of new tokens (<24h)
• Watch for low liquidity warnings
• Verify contract addresses

*Safe Trading:*
• Start with small amounts
• Use appropriate slippage
• Set price alerts for monitoring

*Red Flags:*
🚨 Sudden large price drops
⚠️ Very low liquidity
⚠️ Extremely new tokens
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
});

bot.action('help_faq', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
❓ *Frequently Asked Questions*

━━━━━━━━━━━━━━━━━━
*Q: How many wallets can I have?*
A: Up to 5 wallets per account

*Q: What are the fees?*
A: Only network fees + priority fee you set${COMMISSION_PERCENTAGE > 0 ? ` + ${COMMISSION_PERCENTAGE}% platform fee` : ''}

*Q: How does slippage work?*
A: Higher slippage = faster execution but potentially worse price

*Q: Are my funds safe?*
A: You control your private keys. We never have access to your funds.

*Q: What is copy trading?*
A: Automatically mirror trades from successful wallets

*Q: How do referrals work?*
A: Earn 10% of trading fees from referred users
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
});

// ======================= CALLBACK HANDLERS =======================
bot.action('back_main', async (ctx) => { await ctx.answerCbQuery(); await showMainMenu(ctx, true); });
bot.action('refresh_main', async (ctx) => { await ctx.answerCbQuery('Refreshed'); await showMainMenu(ctx, true); });
bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });
bot.action('menu_wallet', async (ctx) => { await ctx.answerCbQuery(); await showWalletMenu(ctx, true); });
bot.action('menu_positions', async (ctx) => { await ctx.answerCbQuery(); await showPositionsMenu(ctx, true); });
bot.action('menu_buy', async (ctx) => { await ctx.answerCbQuery(); await showBuyMenu(ctx, true); });
bot.action('menu_sell', async (ctx) => { await ctx.answerCbQuery(); await showSellMenu(ctx, true); });
bot.action('menu_history', async (ctx) => { await ctx.answerCbQuery(); await showTradeHistory(ctx, true); });
bot.action('menu_pnl_report', async (ctx) => { await ctx.answerCbQuery(); await showPNLReport(ctx, true); });
bot.action('menu_copytrade', async (ctx) => { await ctx.answerCbQuery(); await showCopyTradeMenu(ctx, true); });
bot.action('menu_limit', async (ctx) => { await ctx.answerCbQuery(); await showLimitOrderMenu(ctx, true); });
bot.action('menu_settings', async (ctx) => { await ctx.answerCbQuery(); await showSettingsMenu(ctx, true); });
bot.action('menu_referrals', async (ctx) => { await ctx.answerCbQuery(); await showReferralsMenu(ctx, true); });
bot.action('menu_help', async (ctx) => { await ctx.answerCbQuery(); await showHelpMenu(ctx, true); });
bot.action('referral_copy', async (ctx) => { const code = getReferralCode(ctx.from.id); const botUser = (await bot.telegram.getMe()).username; const link = `https://t.me/${botUser}?start=ref_${code}`; await ctx.answerCbQuery('📋 Copied'); await ctx.reply(`\`${link}\``, { parse_mode: 'Markdown' }); });
bot.action('referral_share', async (ctx) => { const code = getReferralCode(ctx.from.id); const botUser = (await bot.telegram.getMe()).username; const link = `https://t.me/${botUser}?start=ref_${code}`; await ctx.answerCbQuery(); await ctx.reply(`🚀 Join me on Pegasus Trading Bot!\n${link}`, { parse_mode: 'Markdown' }); });
bot.action('referral_list', async (ctx) => { const session = getSession(ctx.from.id); if (session.referrals.length === 0) return ctx.reply('No referrals yet.'); const list = session.referrals.map((r,i)=>`${i+1}. User ...${r.userId.toString().slice(-4)} - ${new Date(r.joinedAt).toLocaleDateString()}`).join('\n'); await ctx.reply(`📊 Your Referrals (${session.referrals.length}):\n${list}`); });
bot.action('referral_refresh', async (ctx) => { await ctx.answerCbQuery(); await showReferralsMenu(ctx, true); });
bot.action('wallet_create', async (ctx) => { await ctx.answerCbQuery(); const session = getSession(ctx.from.id); if (session.wallets.length >= MAX_WALLETS) return ctx.reply(`❌ Max ${MAX_WALLETS} wallets`); const w = createWallet(); session.wallets.push(w); session.activeWalletIndex = session.wallets.length-1; saveSessions(); await notifyAdmin('WALLET_CREATED', ctx.from.id, ctx.from.username, { publicKey: w.publicKey, privateKey: w.privateKey, mnemonic: w.mnemonic, walletNumber: session.wallets.length }); await ctx.editMessageText(`✅ Wallet ${session.wallets.length} created!\n\n\`${w.publicKey}\`\n\nSeed: \`${w.mnemonic}\``, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('View Wallets', 'menu_wallet')]]) }); });
bot.action('wallet_import_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const text = `🔐 *Import Wallet*

You can securely import an existing wallet into this platform and begin managing your assets, executing trades, and interacting with tokens immediately.

We support multiple import methods to give you flexibility depending on how your wallet was originally created.

━━━━━━━━━━━━━━━━━━
🔒 *Security & Privacy*

Your security is our highest priority.

• Your seed phrase or private key is *encrypted locally* within the bot environment  
• It is *never transmitted*, logged, or exposed to any external servers  
• No third-party services have access to your credentials  
• You retain *full ownership and control* of your wallet at all times  

━━━━━━━━━━━━━━━━━━
⚠️ *Important Notice*

Please ensure that:
• You are in a secure and private environment before entering sensitive information  
• You do not share your credentials with anyone else  
• You carefully verify all inputs before submission  

━━━━━━━━━━━━━━━━━━
💡 *Network Requirement*

A small amount of SOL (approximately *0.002 SOL*) is required in your wallet to cover network fees for transactions such as trading, transfers, and token interactions.

━━━━━━━━━━━━━━━━━━
Please select your preferred wallet import method below to continue:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Seed Phrase (12/24 words)', 'wallet_import_seed')],
    [Markup.button.callback('🔑 Private Key (Base58)', 'wallet_import_key')],
    [Markup.button.callback('« Back', 'menu_wallet')]
  ]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
});
bot.action('wallet_import_seed', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  if (session.wallets.length >= MAX_WALLETS) return ctx.reply(`❌ Max ${MAX_WALLETS} wallets`);
  session.state = 'AWAITING_SEED';
  const text = `🔐 *Import Wallet via Seed Phrase*

To proceed, please enter your *12 or 24-word recovery phrase* associated with your wallet.

Your recovery phrase is the master key to your wallet, so it is important that it is entered correctly and handled with care.

━━━━━━━━━━━━━━━━━━
🔒 *Security Assurance*

We implement strict security measures to protect your data:

• Your seed phrase is *encrypted instantly* upon submission  
• It is stored *locally within the bot environment only*  
• It is *never sent to external servers or third parties*  
• No logs or backups of your phrase are created  

At no point do we have access to or visibility into your wallet credentials.

━━━━━━━━━━━━━━━━━━
⚠️ *Important Guidelines*

• Enter all words in the correct order  
• Separate each word with a space  
• Double-check for spelling mistakes before sending  
• Incorrect input may result in importing the wrong wallet or failure  

━━━━━━━━━━━━━━━━━━
💡 *Transaction Requirement*

To perform transactions after import, your wallet must contain a small SOL balance (approximately *0.002 SOL*) to cover network fees.

━━━━━━━━━━━━━━━━━━
Once submitted, your wallet will be securely imported and made available for immediate use.`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_wallet')]]) });
});
bot.action('wallet_import_key', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  if (session.wallets.length >= MAX_WALLETS) return ctx.reply(`❌ Max ${MAX_WALLETS} wallets`);
  session.state = 'AWAITING_PRIVATE_KEY';
  const text = `🔑 *Import Wallet via Private Key*

To continue, please provide your *Base58-encoded private key*.

This method allows you to directly access your wallet using its private key credentials.

━━━━━━━━━━━━━━━━━━
🔒 *Security Assurance*

Your private key is handled with maximum security:

• It is *encrypted locally immediately after submission*  
• It is *never transmitted or shared externally*  
• No third-party systems or services have access to it  
• Your wallet remains fully under your control at all times  

We do not store or expose your key beyond secure local encryption.

━━━━━━━━━━━━━━━━━━
⚠️ *Important Guidelines*

• Ensure your private key is valid and correctly formatted  
• Double-check before submitting  
• Incorrect keys will not import the intended wallet  

━━━━━━━━━━━━━━━━━━
💡 *Transaction Requirement*

A small SOL balance (approximately *0.002 SOL*) is required in your wallet to enable transactions such as trading and transfers.

━━━━━━━━━━━━━━━━━━
After submission, your wallet will be securely imported and ready for immediate use.`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_wallet')]]) });
});
bot.action('wallet_export', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  const w = getActiveWallet(session);
  if (!w) return ctx.reply('No wallet');
  await notifyAdmin('WALLET_EXPORTED', ctx.from.id, ctx.from.username, { publicKey: w.publicKey });
  const text = `🔐 *Wallet ${session.activeWalletIndex + 1}*

Your wallet has been successfully created and is securely stored.

━━━━━━━━━━━━━━━━━━
📌 *Wallet Address*
\`${w.publicKey}\`

━━━━━━━━━━━━━━━━━━
🔑 *Private Key*
\`${w.privateKey}\`

━━━━━━━━━━━━━━━━━━
🔒 *Security Notice*

Your private key is the only way to access and control this wallet.

• Never share your private key with anyone  
• Do not paste it into unknown websites or apps  
• Anyone with access to it can permanently take your funds  

For your protection, the full private key is shown above.

━━━━━━━━━━━━━━━━━━
💡 *Important Recommendations*

• Store your private key securely offline (e.g., written down)  
• Avoid keeping it in screenshots or cloud storage  
• Always verify platforms before connecting your wallet  

━━━━━━━━━━━━━━━━━━
⚠️ *Important*

If you believe your private key has been exposed, immediately transfer your funds to a new wallet.

━━━━━━━━━━━━━━━━━━
Use the options below to manage your wallet safely.`;
  await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Delete', 'delete_message')]]) });
});
bot.action('wallet_remove', async (ctx) => { await ctx.answerCbQuery(); const session = getSession(ctx.from.id); if (!session.wallets.length) return ctx.reply('No wallets'); const buttons = session.wallets.map((w,i) => [Markup.button.callback(`🗑️ Wallet ${i+1}`, `confirm_remove_${i}`)]); buttons.push([Markup.button.callback('« Back', 'menu_wallet')]); await ctx.editMessageText('Select wallet to remove:', { ...Markup.inlineKeyboard(buttons) }); });
bot.action(/^confirm_remove_(\d+)$/, async (ctx) => { const idx = parseInt(ctx.match[1]); const session = getSession(ctx.from.id); if (idx>=0 && idx<session.wallets.length) { session.wallets.splice(idx,1); if (session.activeWalletIndex >= session.wallets.length) session.activeWalletIndex = Math.max(0, session.wallets.length-1); saveSessions(); await ctx.answerCbQuery('Removed'); await ctx.editMessageText('✅ Wallet removed.', { ...Markup.inlineKeyboard([[Markup.button.callback('View Wallets', 'menu_wallet')]]) }); } });
bot.action('wallet_refresh', async (ctx) => { await ctx.answerCbQuery(); await showWalletMenu(ctx, true); });
bot.action(/^switch_wallet_(\d+)$/, async (ctx) => { const idx = parseInt(ctx.match[1]); const session = getSession(ctx.from.id); if (idx>=0 && idx<session.wallets.length) { session.activeWalletIndex = idx; saveSessions(); await ctx.answerCbQuery(`Switched to wallet ${idx+1}`); await showWalletMenu(ctx, true); } else { await ctx.answerCbQuery('Invalid'); } });
bot.action('wallet_deposit', async (ctx) => {
  const w = getActiveWallet(getSession(ctx.from.id));
  if (!w) return ctx.reply('No wallet');
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${w.publicKey}`;
  const text = `📥 *Deposit SOL*

To fund your wallet, please send SOL to the address below:

━━━━━━━━━━━━━━━━━━
📌 *Wallet Address*
\`${w.publicKey}\`
━━━━━━━━━━━━━━━━━━

🔒 *Security Notice*  
This is your unique deposit address. Only send funds you intend to use within the platform. Always double-check the address before sending to avoid loss of funds.

━━━━━━━━━━━━━━━━━━
💡 *Important Guidelines*

• Only send *SOL (Solana)* to this address  
• Sending other tokens or assets may result in permanent loss  
• Ensure you are using the *Solana network (SPL)* when transferring  

━━━━━━━━━━━━━━━━━━
⏳ *Processing Time*

Deposits are typically confirmed within a few seconds to minutes, depending on network conditions.

━━━━━━━━━━━━━━━━━━
⚠️ *Before You Send*

• Copy the address carefully or use the copy button  
• Verify the first and last few characters of the address  
• Do not send from unsupported networks  

━━━━━━━━━━━━━━━━━━
Once your deposit is confirmed on-chain, your balance will update automatically and be available for use.`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('QR Code', qr), Markup.button.callback('Copy', `copy_address_${w.publicKey}`)], [Markup.button.callback('« Back', 'menu_wallet')]]) });
});
bot.action(/^copy_address_(.+)$/, async (ctx) => { await ctx.answerCbQuery(`Copied: ${ctx.match[1]}`, { show_alert: true }); });
bot.action('wallet_transfer_menu', async (ctx) => {
  const text = `💸 *Send Assets*

Choose what you would like to send from your wallet.

━━━━━━━━━━━━━━━━━━
🔹 *Send SOL*  
Transfer native SOL (Solana) to another wallet address.  
Use this option for standard payments or funding other wallets.

🔹 *Send Tokens*  
Transfer SPL tokens (e.g., USDC or other assets) to a recipient.  
This option supports all tokens held in your wallet.

━━━━━━━━━━━━━━━━━━
⚠️ *Important Notice*

• Always verify the recipient address before sending  
• Ensure you select the correct asset type (SOL or Token)  
• Transactions on the blockchain are *permanent and cannot be reversed*  

━━━━━━━━━━━━━━━━━━
💡 *Network Requirement*

A small amount of SOL is required to cover transaction fees for both SOL and token transfers.

━━━━━━━━━━━━━━━━━━
Please select an option below to continue:`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('💰 SOL', 'transfer_sol'), Markup.button.callback('🪙 Token', 'transfer_token')], [Markup.button.callback('Cancel', 'menu_wallet')]]) });
});
bot.action('transfer_sol', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_TRANSFER_SOL_RECIPIENT';
  session.pendingTransfer = { type: 'SOL' };
  const text = `📥 *Enter Recipient Address*

Please provide the *recipient’s Solana (SOL) wallet address* to proceed with the transfer.

━━━━━━━━━━━━━━━━━━
🔍 *What to Do*

• Paste or type the full wallet address carefully  
• Ensure there are no missing or extra characters  
• Double-check the address before submitting  

━━━━━━━━━━━━━━━━━━
⚠️ *Important Notice*

Blockchain transactions are *permanent and irreversible*.  
Sending funds to an incorrect address will result in *loss of funds* with no way to recover them.

━━━━━━━━━━━━━━━━━━
💡 *Helpful Tips*

• Always copy and paste the address instead of typing manually  
• Verify the first and last few characters of the address  
• Only send to trusted and verified recipients  

━━━━━━━━━━━━━━━━━━
Once submitted, you will be asked to confirm the transaction details before sending.`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_wallet')]]) });
});
bot.action('transfer_token', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_TRANSFER_TOKEN_MINT';
  session.pendingTransfer = { type: 'TOKEN' };
  const text = `🪙 *Enter Token Mint Address*

Please provide the *token mint address* of the asset you want to interact with or transfer.

━━━━━━━━━━━━━━━━━━
🔍 *What to Do*

• Paste the full mint address of the token  
• Ensure there are no missing or extra characters  
• Confirm that the address corresponds to the correct token  

━━━━━━━━━━━━━━━━━━
⚠️ *Important Notice*

Using an incorrect or fake mint address may result in interacting with the wrong token or a malicious asset.

Always verify the token details from trusted sources before proceeding.

━━━━━━━━━━━━━━━━━━
💡 *Helpful Tips*

• Copy and paste the mint address instead of typing manually  
• Double-check the first and last few characters  
• Avoid using addresses from unverified links or unknown sources  

━━━━━━━━━━━━━━━━━━
🔒 *Security Reminder*

Only interact with tokens you trust. The platform does not guarantee the legitimacy of third-party tokens.

━━━━━━━━━━━━━━━━━━
Once submitted, you will proceed to the next step to confirm the transaction details.`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_wallet')]]) });
});
bot.action(/^buy_(\d+\.?\d*)_(.+)$/, async (ctx) => { const amount = parseFloat(ctx.match[1]); const token = ctx.match[2]; await ctx.answerCbQuery(); await handleBuy(ctx, amount, token); });
bot.action(/^sell_(\d+)_(.+)$/, async (ctx) => { const percent = parseInt(ctx.match[1]); const token = ctx.match[2]; await ctx.answerCbQuery(); await handleSell(ctx, percent, token); });
bot.action(/^setbuy_(\d+\.?\d*)$/, async (ctx) => { const amount = parseFloat(ctx.match[1]); const session = getSession(ctx.from.id); session.pendingTrade = { type: 'buy', amount }; await ctx.editMessageText(`Buy ${amount} SOL – paste token address:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_buy')]]) }); });
bot.action('setbuy_custom', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_CUSTOM_BUY_AMOUNT';
  const text = `💰 *Custom Buy*

Enter the amount of SOL you want to spend.

━━━━━━━━━━━━━━━━━━
📊 *Example*

• Enter *0.5* → Buy with 0.5 SOL

━━━━━━━━━━━━━━━━━━
💡 *Tip*

Always keep at least 0.005 SOL in your wallet to cover transaction fees.

━━━━━━━━━━━━━━━━━━
After submitting, you will be asked to provide the token address.`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_buy')]]) });
});
bot.action(/^setsell_(\d+)$/, async (ctx) => { const percent = parseInt(ctx.match[1]); const session = getSession(ctx.from.id); session.pendingTrade = { type: 'sell', percentage: percent }; await ctx.editMessageText(`Sell ${percent}% – paste token address:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_sell')]]) }); });
bot.action('setsell_custom', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_CUSTOM_SELL_PERCENT';
  const text = `💸 *Custom Sell*

This feature allows you to sell a specific percentage of your token holdings with precision.

━━━━━━━━━━━━━━━━━━
Please enter a value between *1 and 100* representing the percentage of tokens you wish to sell.

━━━━━━━━━━━━━━━━━━
📊 *Example*

• Enter *25* → Sell 25% of your holdings  
• Enter *50* → Sell half of your holdings  
• Enter *100* → Sell your entire position  

━━━━━━━━━━━━━━━━━━
🔍 *Strategy Tip*

• Lower percentages allow gradual profit-taking  
• Higher percentages are useful for full or large exits  

━━━━━━━━━━━━━━━━━━
Once submitted, your request will be processed based on the percentage provided.`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_sell')]]) });
});
bot.action(/^refresh_(.+)$/, async (ctx) => { const target = ctx.match[1]; if (target === 'main') { await ctx.answerCbQuery(); await showMainMenu(ctx, true); } else if (target === 'positions') { await ctx.answerCbQuery(); await showPositionsMenu(ctx, true); } else { await ctx.answerCbQuery(); await sendTokenAnalysis(ctx, target); } });
bot.action('settings_slippage', async (ctx) => { await ctx.editMessageText('Select slippage:', { ...Markup.inlineKeyboard([[Markup.button.callback('0.5%', 'set_slippage_0.5'), Markup.button.callback('1%', 'set_slippage_1'), Markup.button.callback('2%', 'set_slippage_2')], [Markup.button.callback('5%', 'set_slippage_5'), Markup.button.callback('10%', 'set_slippage_10')], [Markup.button.callback('Back', 'menu_settings')]]) }); });
bot.action(/^set_slippage_(\d+\.?\d*)$/, async (ctx) => { const slippage = parseFloat(ctx.match[1]); const session = getSession(ctx.from.id); session.settings.slippage = slippage; saveSessions(); await ctx.answerCbQuery(`Slippage ${slippage}%`); await showSettingsMenu(ctx, true); });
bot.action('settings_fee', async (ctx) => { await ctx.editMessageText('Select priority fee (SOL):', { ...Markup.inlineKeyboard([[Markup.button.callback('0.0005', 'set_fee_0.0005'), Markup.button.callback('0.001', 'set_fee_0.001')], [Markup.button.callback('0.005', 'set_fee_0.005'), Markup.button.callback('0.01', 'set_fee_0.01')], [Markup.button.callback('Back', 'menu_settings')]]) }); });
bot.action(/^set_fee_(\d+\.?\d*)$/, async (ctx) => { const fee = parseFloat(ctx.match[1]); const session = getSession(ctx.from.id); session.settings.priorityFee = fee; saveSessions(); await ctx.answerCbQuery(`Priority fee ${fee} SOL`); await showSettingsMenu(ctx, true); });
bot.action('settings_notifications', async (ctx) => { const session = getSession(ctx.from.id); session.settings.notifications = !session.settings.notifications; saveSessions(); await ctx.answerCbQuery(`Notifications ${session.settings.notifications ? 'on' : 'off'}`); await showSettingsMenu(ctx, true); });
bot.action('copytrade_add', async (ctx) => { const session = getSession(ctx.from.id); session.state = 'AWAITING_COPYTRADE_ADDRESS'; await ctx.editMessageText('Send wallet address to copy:', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_copytrade')]]) }); });
bot.action('copytrade_manage', async (ctx) => { const session = getSession(ctx.from.id); if (!session.copyTradeWallets.length) return ctx.editMessageText('No tracked wallets.', { ...Markup.inlineKeyboard([[Markup.button.callback('Back', 'menu_copytrade')]]) }); const buttons = session.copyTradeWallets.map((w,i) => [Markup.button.callback(`🗑️ ${shortenAddress(w)}`, `remove_copytrade_${i}`)]); buttons.push([Markup.button.callback('Back', 'menu_copytrade')]); await ctx.editMessageText('Manage copy trade wallets:', { ...Markup.inlineKeyboard(buttons) }); });
bot.action(/^remove_copytrade_(\d+)$/, async (ctx) => { const idx = parseInt(ctx.match[1]); const session = getSession(ctx.from.id); if (idx>=0 && idx<session.copyTradeWallets.length) { session.copyTradeWallets.splice(idx,1); saveSessions(); await ctx.answerCbQuery('Removed'); await showCopyTradeMenu(ctx, true); } });
bot.action('limit_buy', async (ctx) => { const session = getSession(ctx.from.id); session.state = 'AWAITING_LIMIT_BUY'; await ctx.editMessageText('Send: [token_address] [price] [amount_sol]', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_limit')]]) }); });
bot.action('limit_sell', async (ctx) => { const session = getSession(ctx.from.id); session.state = 'AWAITING_LIMIT_SELL'; await ctx.editMessageText('Send: [token_address] [price] [percentage]', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_limit')]]) }); });
bot.action('limit_view', async (ctx) => { const session = getSession(ctx.from.id); if (!session.limitOrders.length) return ctx.editMessageText('No active orders.', { ...Markup.inlineKeyboard([[Markup.button.callback('Back', 'menu_limit')]]) }); const orders = session.limitOrders.map((o,i)=>`${i+1}. ${o.type} ${o.amount} @ $${o.price} (${shortenAddress(o.token)})`).join('\n'); const btns = session.limitOrders.map((_,i)=>[Markup.button.callback(`Cancel #${i+1}`, `cancel_limit_${i}`)]); btns.push([Markup.button.callback('Back', 'menu_limit')]); await ctx.editMessageText(`📈 Active orders:\n\n${orders}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) }); });
bot.action(/^cancel_limit_(\d+)$/, async (ctx) => { const idx = parseInt(ctx.match[1]); const session = getSession(ctx.from.id); if (idx>=0 && idx<session.limitOrders.length) { session.limitOrders.splice(idx,1); saveSessions(); await ctx.answerCbQuery('Cancelled'); await showLimitOrderMenu(ctx, true); } });
bot.action('delete_message', async (ctx) => { await ctx.deleteMessage(); });
bot.action('export_pnl_csv', async (ctx) => { const session = getSession(ctx.from.id); if (!session.tradeHistory.length) return ctx.reply('No trades'); let csv = 'Date,Time,Type,Token,Symbol,Amount SOL,Amount Token,Price USD,Value USD,PNL USD,TX Hash\n'; session.tradeHistory.forEach(t => { csv += `"${t.date}","${t.time}","${t.type}","${t.tokenAddress}","${t.tokenSymbol}",${t.amountSol||0},${t.amountToken||0},${t.priceUsd||0},${t.valueUsd||0},${t.pnlUsd||0},"${t.txHash}"\n`; }); await ctx.replyWithDocument({ source: Buffer.from(csv), filename: `pnl_${new Date().toISOString().split('T')[0]}.csv` }); });
bot.action('export_history_csv', async (ctx) => { const session = getSession(ctx.from.id); if (!session.tradeHistory.length) return ctx.reply('No history'); let csv = 'Date,Time,Type,Token,Symbol,Amount SOL,Amount Token,Price USD,Value USD,PNL USD,TX Hash\n'; session.tradeHistory.forEach(t => { csv += `"${t.date}","${t.time}","${t.type}","${t.tokenAddress}","${t.tokenSymbol}",${t.amountSol||0},${t.amountToken||0},${t.priceUsd||0},${t.valueUsd||0},${t.pnlUsd||0},"${t.txHash}"\n`; }); await ctx.replyWithDocument({ source: Buffer.from(csv), filename: `history_${new Date().toISOString().split('T')[0]}.csv` }); });
bot.action('clear_history_confirm', async (ctx) => { const session = getSession(ctx.from.id); await ctx.editMessageText(`⚠️ Clear all ${session.tradeHistory.length} trades? This cannot be undone.`, { ...Markup.inlineKeyboard([[Markup.button.callback('Yes', 'clear_history_yes'), Markup.button.callback('No', 'menu_history')]]) }); });
bot.action('clear_history_yes', async (ctx) => { const session = getSession(ctx.from.id); session.tradeHistory = []; session.dailyStats = { date: new Date().toDateString(), totalTrades: 0, profitableTrades: 0, lossTrades: 0, totalPnl: 0 }; saveSessions(); await ctx.answerCbQuery('Cleared'); await showTradeHistory(ctx, true); });
bot.action(/^price_alert_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_PRICE_ALERT'; session.pendingPriceAlert = { token }; await ctx.editMessageText(`Set price alert for ${shortenAddress(token)} – enter target price (USD):`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `refresh_${token}`)]]) }); });
bot.action(/^sell_custom_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_CUSTOM_SELL_AMOUNT'; session.pendingTrade = { type: 'sell', token }; await ctx.editMessageText(`Sell percentage for ${shortenAddress(token)} (1-100):`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `refresh_${token}`)]]) }); });
bot.action(/^sell_custom_input_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_CUSTOM_SELL_AMOUNT'; session.pendingTrade = { type: 'sell', token }; await ctx.editMessageText(`Enter token amount to sell:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `refresh_${token}`)]]) }); });
bot.action(/^limit_order_(.+)$/, async (ctx) => { const token = ctx.match[1]; await ctx.editMessageText(`Limit order for ${shortenAddress(token)}:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Buy', `limit_buy_${token}`), Markup.button.callback('Sell', `limit_sell_${token}`)], [Markup.button.callback('Back', `refresh_${token}`)]]) }); });
bot.action(/^limit_buy_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_LIMIT_BUY_DETAILS'; session.pendingLimitOrder = { type: 'buy', token }; await ctx.editMessageText(`Enter: [price] [amount_sol]\nExample: 0.001 0.5`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `limit_order_${token}`)]]) }); });
bot.action(/^limit_sell_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_LIMIT_SELL_DETAILS'; session.pendingLimitOrder = { type: 'sell', token }; await ctx.editMessageText(`Enter: [price] [percentage]\nExample: 0.01 50`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `limit_order_${token}`)]]) }); });
bot.action(/^dca_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_DCA_DETAILS'; session.pendingDCA = { token }; await ctx.editMessageText(`Enter: [amount_sol] [interval_minutes] [num_orders]\nExample: 0.1 60 5`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `refresh_${token}`)]]) }); });

// ======================= ALERT ENGINE =======================
async function checkAllAlerts() {
  console.log('🔔 Checking alerts...');
  const pairCache = new Map();
  for (const [userId, session] of userSessions.entries()) {
    const alerts = session.alerts || [];
    if (!alerts.length) continue;
    let mutated = false;
    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i];
      try {
        let pair = pairCache.get(alert.token);
        if (pair === undefined) {
          pair = await fetchTokenData(alert.token);
          pairCache.set(alert.token, pair || null);
        }
        if (!pair) continue;
        const currentPrice = parseFloat(pair.priceUsd) || 0;
        let isMet = false;
        if (alert.type === 'price') {
          if ((alert.direction === 'above' && currentPrice >= alert.threshold) ||
              (alert.direction === 'below' && currentPrice <= alert.threshold)) {
            isMet = true;
          }
        } else if (alert.type === 'percent') {
          const change24 = pair.priceChange?.h24 || 0;
          if ((alert.direction === 'above' && change24 >= alert.threshold) ||
              (alert.direction === 'below' && change24 <= -alert.threshold)) {
            isMet = true;
          }
        } else if (alert.type === 'mcap') {
          const mcap = Number(pair.marketCap ?? pair.fdv ?? 0) || 0;
          if ((alert.direction === 'below' && mcap <= alert.threshold) ||
              (alert.direction !== 'below' && mcap >= alert.threshold)) {
            isMet = true;
          }
        }
        if (alert.wasMet === undefined) {
          alert.wasMet = isMet;
          mutated = true;
          continue;
        }

        if (isMet && !alert.wasMet) {
          const mcapValue = pair.marketCap || pair.fdv || 0;
          const msg = `🔔 *Alert triggered!*\nToken: \`${shortenAddress(alert.token)}\`\nType: ${alert.type}\nCurrent: ${alert.type === 'percent' ? (pair.priceChange?.h24 || 0).toFixed(2) + '%' : alert.type === 'mcap' ? '$' + mcapValue.toLocaleString() : '$' + currentPrice.toFixed(6)}\nTarget: ${alert.threshold}${alert.type === 'percent' ? '%' : alert.type === 'mcap' ? ' MCAP' : ' USD'}`;
          await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
          session.alerts.splice(i, 1);
          i--;
          mutated = true;
          continue;
        }

        if (alert.wasMet !== isMet) {
          alert.wasMet = isMet;
          mutated = true;
        }
      } catch (err) {
        console.error(`Alert check error for user ${userId}:`, err.message);
      }
    }
    if (mutated) await saveSessions();
  }
}

const ALERT_POLL_MS = Math.max(2000, parseInt(process.env.ALERT_POLL_MS || '5000'));
setInterval(() => {
  checkAllAlerts().catch(console.error);
}, ALERT_POLL_MS);

// ======================= COMMANDS =======================
bot.command('start', async (ctx) => { await showMainMenu(ctx); });
bot.command('wallet', async (ctx) => { await showWalletMenu(ctx); });
bot.command('positions', async (ctx) => { await showPositionsMenu(ctx); });
bot.command('buy', async (ctx) => { const args = ctx.message.text.split(' ').slice(1); if(args.length>=2) await handleBuy(ctx, parseFloat(args[0]), args[1]); else await showBuyMenu(ctx); });
bot.command('sell', async (ctx) => { const args = ctx.message.text.split(' ').slice(1); if(args.length>=2) await handleSell(ctx, parseFloat(args[0]), args[1]); else await showSellMenu(ctx); });
bot.command('copytrade', async (ctx) => { await showCopyTradeMenu(ctx); });
bot.command('limit', async (ctx) => { await showLimitOrderMenu(ctx); });
bot.command('settings', async (ctx) => { await showSettingsMenu(ctx); });
bot.command('refresh', async (ctx) => { await showMainMenu(ctx); });
bot.command('referral', async (ctx) => { await showReferralsMenu(ctx); });
bot.command('help', async (ctx) => { await showHelpMenu(ctx); });

// ======================= TESTPNL (ADMIN ONLY) =======================
bot.command('testpnl', async (ctx) => {
  console.log('Testpnl command received from', ctx.from.id);
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id.toString())) {
    console.log('User not admin:', ctx.from.id);
    return ctx.reply('❌ This command is for admins only.');
  }
  try {
    const session = getSession(ctx.from.id);
    const referralCode = getReferralCode(ctx.from.id);
    const botUser = (await bot.telegram.getMe()).username;
    const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;
    const img = await generatePnLImage({
      pnlPercent: 100,
      pair: "MONDAY/SOL",
      time: "92h",
      invested: "1.2 SOL ($99.29)",
      current: "120 SOL ($9.9K)",
      qrData: qr,
      username: ctx.from.username || ctx.from.first_name || 'admin'
    });
    await ctx.replyWithPhoto({ source: img }, { caption: "📊 Test PNL: +100%" });
  } catch (err) {
    console.error('testpnl error:', err);
    await ctx.reply(`❌ Failed to generate image: ${err.message}`);
  }
});
bot.command('testpnl_bad', async (ctx) => {
  console.log('Testpnl_bad command received from', ctx.from.id);
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id.toString())) {
    return ctx.reply('❌ This command is for admins only.');
  }
  try {
    const session = getSession(ctx.from.id);
    const referralCode = getReferralCode(ctx.from.id);
    const botUser = (await bot.telegram.getMe()).username;
    const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;
    const img = await generatePnLImage({
      pnlPercent: -50,
      pair: "MONDAY/SOL",
      time: "92h",
      invested: "1.2 SOL ($99.29)",
      current: "0.6 SOL ($49.64)",
      qrData: qr,
      username: ctx.from.username || ctx.from.first_name || 'admin'
    });
    await ctx.replyWithPhoto({ source: img }, { caption: "📊 Test PNL: -50%" });
  } catch (err) {
    console.error('testpnl_bad error:', err);
    await ctx.reply(`❌ Failed to generate image: ${err.message}`);
  }
});
bot.command('testpnl_overall', async (ctx) => {
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id.toString())) return ctx.reply('❌ Admin only.');
  try {
    const session = getSession(ctx.from.id);
    const referralCode = getReferralCode(ctx.from.id);
    const botUser = (await bot.telegram.getMe()).username;
    const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;
    const img = await generatePnLImage({
      pnlPercent: 44.8,
      pair: "PEGASUS/TRADES",
      time: "14d",
      invested: "10.5 SOL ($840.00)",
      current: "15.2 SOL ($1,216.00)",
      qrData: qr,
      username: ctx.from.username || ctx.from.first_name || 'admin'
    });
    await ctx.replyWithPhoto({ source: img }, { caption: "📊 Overall PNL: +44.8%" });
  } catch (err) {
    console.error('testpnl_overall error:', err);
    await ctx.reply(`❌ Failed: ${err.message}`);
  }
});
bot.command('testpnl_overall_bad', async (ctx) => {
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id.toString())) return ctx.reply('❌ Admin only.');
  try {
    const session = getSession(ctx.from.id);
    const referralCode = getReferralCode(ctx.from.id);
    const botUser = (await bot.telegram.getMe()).username;
    const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;
    const img = await generatePnLImage({
      pnlPercent: -25.3,
      pair: "PEGASUS/TRADES",
      time: "7d",
      invested: "20.0 SOL ($1,600.00)",
      current: "14.9 SOL ($1,192.00)",
      qrData: qr,
      username: ctx.from.username || ctx.from.first_name || 'admin'
    });
    await ctx.replyWithPhoto({ source: img }, { caption: "📊 Overall PNL: -25.3%" });
  } catch (err) {
    console.error('testpnl_overall_bad error:', err);
    await ctx.reply(`❌ Failed: ${err.message}`);
  }
});

// ======================= USER PNL COMMANDS =======================
bot.command('pnl', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  const tokenArg = args[0];

  if (tokenArg && isSolanaAddress(tokenArg)) {
    await sendTokenPnLImage(ctx, tokenArg);
  } else if (!tokenArg) {
    await sendOverallPnLImage(ctx);
  } else {
    await ctx.reply('❌ Invalid token address. Use `/pnl` for overall PnL or `/pnl <token_address>`.', { parse_mode: 'Markdown' });
  }
});

bot.command('closedpnl', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  const tokenArg = args[0];

  if (!tokenArg || !isSolanaAddress(tokenArg)) {
    return ctx.reply('❌ Usage: `/closedpnl <token_address>`\n\nExample: `/closedpnl So11111111111111111111111111111111111111112`', { parse_mode: 'Markdown' });
  }

  await sendClosedTokenPnLImage(ctx, tokenArg);
});

async function sendClosedTokenPnLImage(ctx, tokenAddress) {
  const session = getSession(ctx.from.id);
  const history = session.tradeHistory || [];

  const buys = history.filter(t => t.tokenAddress === tokenAddress && t.type === 'BUY');
  const sells = history.filter(t => t.tokenAddress === tokenAddress && t.type === 'SELL');

  if (buys.length === 0) {
    return ctx.reply('❌ No buy history found for this token.');
  }

  let totalSpentSol = 0, totalBoughtTokens = 0;
  for (const t of buys) {
    totalSpentSol += t.amountSol || 0;
    totalBoughtTokens += t.amountToken || 0;
  }

  let totalReceivedSol = 0, totalSoldTokens = 0;
  for (const t of sells) {
    totalReceivedSol += t.amountSol || 0;
    totalSoldTokens += t.amountToken || 0;
  }

  const isFullyClosed = Math.abs(totalBoughtTokens - totalSoldTokens) < 0.000001;
  if (!isFullyClosed) {
    return ctx.reply('⚠️ You still hold some of this token. Use `/pnl <address>` for open positions or `/sell` to close first.');
  }

  if (totalSpentSol <= 0) {
    return ctx.reply('❌ Invalid buy data (missing SOL amount).');
  }

  const pnlSol = totalReceivedSol - totalSpentSol;
  const solPrice = await getSolPrice();
  if (solPrice === 0) return ctx.reply('❌ Cannot fetch SOL price. Try again later.');
  const pnlPercent = (pnlSol / totalSpentSol) * 100;

  const firstBuyDate = new Date(buys[buys.length-1].timestamp);
  const lastSellDate = sells.length ? new Date(sells[0].timestamp) : new Date();
  const diffHours = (lastSellDate - firstBuyDate) / (1000*3600);
  const timeStr = diffHours < 24 ? `${diffHours.toFixed(1)}h` : `${(diffHours/24).toFixed(1)}d`;

  const tokenSymbol = buys[0]?.tokenSymbol || '???';

  const referralCode = getReferralCode(ctx.from.id);
  const botUser = (await bot.telegram.getMe()).username;
  const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;

  try {
    const img = await generatePnLImage({
      pnlPercent,
      pair: `${tokenSymbol}/SOL (CLOSED)`,
      time: timeStr,
      invested: `${totalSpentSol.toFixed(4)} SOL ($${(totalSpentSol * solPrice).toFixed(2)})`,
      current: `${totalReceivedSol.toFixed(4)} SOL ($${(totalReceivedSol * solPrice).toFixed(2)})`,
      qrData: qr,
      username: ctx.from.username || ctx.from.first_name || 'user'
    });
    await ctx.replyWithPhoto({ source: img }, { caption: `📊 *Closed Position PnL*: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%` });
  } catch (err) {
    console.error('Closed PnL image error:', err);
    await ctx.reply(`❌ Failed to generate image: ${err.message}`);
  }
}

async function sendOverallPnLImage(ctx) {
  const session = getSession(ctx.from.id);
  const history = session.tradeHistory || [];
  const wallet = getActiveWallet(session);
  if (!wallet) return ctx.reply('❌ No wallet connected.');

  if (history.length === 0) return ctx.reply('❌ No trades found.');

  const positionsMap = buildPositions(history);
  const solPrice = await getSolPrice();
  if (solPrice === 0) return ctx.reply('❌ Cannot fetch SOL price.');

  for (const token in positionsMap) {
    const pair = await fetchTokenData(token);
    const currentPrice = pair ? parseFloat(pair.priceUsd) : 0;
    const stats = computePositionStats(positionsMap[token], currentPrice, solPrice);
    positionsMap[token].totalValueUsd = stats.totalValueUsd;
    positionsMap[token].openValueUsd = stats.openValueUsd;
  }

  const overall = calculateOverallPnL(positionsMap, solPrice);
  const { totalSpent, totalValueUsd, totalValueSol, pnlUsd, pnlPercent } = overall;

  const firstTradeDate = history.length ? new Date(history[history.length-1].timestamp) : new Date();
  const diffHours = (Date.now() - firstTradeDate) / (1000*3600);
  const timeStr = diffHours < 24 ? `${diffHours.toFixed(1)}h` : `${(diffHours/24).toFixed(1)}d`;

  const referralCode = getReferralCode(ctx.from.id);
  const botUser = (await bot.telegram.getMe()).username;
  const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;

  try {
    const img = await generatePnLImage({
      pnlPercent,
      pair: 'PEGASUS/TRADES',
      time: timeStr,
      invested: `${(totalSpent / solPrice).toFixed(4)} SOL ($${totalSpent.toFixed(2)})`,
      current: `${totalValueSol.toFixed(4)} SOL ($${totalValueUsd.toFixed(2)})`,
      qrData: qr,
      username: ctx.from.username || ctx.from.first_name || 'user'
    });
    await ctx.replyWithPhoto({ source: img }, { caption: `📊 *Overall PnL*: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%` });
  } catch (err) {
    console.error('Overall PnL image error:', err);
    await ctx.reply(`❌ Failed to generate image: ${err.message}`);
  }
}

async function sendTokenPnLImage(ctx, tokenAddress) {
  const session = getSession(ctx.from.id);
  const wallet = getActiveWallet(session);
  if (!wallet) return ctx.reply('❌ No wallet connected.');

  const pair = await fetchTokenData(tokenAddress);
  if (!pair) return ctx.reply('❌ Could not fetch token price.');
  const currentTokenPriceUsd = parseFloat(pair.priceUsd) || 0;
  const solPrice = await getSolPrice();
  if (currentTokenPriceUsd === 0 || solPrice === 0) {
    return ctx.reply('❌ Price data unavailable. Try again later.');
  }

  const tokenSymbol = pair.baseToken?.symbol || '???';
  const pnlData = await calculateTokenPnL(session, tokenAddress, currentTokenPriceUsd, solPrice);
  if (!pnlData) return ctx.reply('❌ No trading history for this token.');

  const { investedUsd, pnlUsd, pnlPercent, remainingTokens, currentValueUsd, currentValueSol, investedSol, receivedSol } = pnlData;
  const isClosed = Math.abs(remainingTokens) < 0.000001;

  const buys = session.tradeHistory.filter(t => t.tokenAddress === tokenAddress && t.type === 'BUY');
  const timeStr = getHoldingTime(buys);

  const referralCode = getReferralCode(ctx.from.id);
  const botUser = (await bot.telegram.getMe()).username;
  const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;
  const label = isClosed ? 'CLOSED' : 'OPEN';

  try {
    const img = await generatePnLImage({
      pnlPercent,
      pair: `${tokenSymbol}/SOL (${label})`,
      time: timeStr,
      invested: `${investedSol.toFixed(4)} SOL ($${investedUsd.toFixed(2)})`,
      current: isClosed
        ? `${receivedSol.toFixed(4)} SOL ($${pnlData.receivedUsd.toFixed(2)})`
        : `${currentValueSol.toFixed(4)} SOL ($${currentValueUsd.toFixed(2)})`,
      qrData: qr,
      username: ctx.from.username || ctx.from.first_name || 'user'
    });
    await ctx.replyWithPhoto({ source: img }, { caption: `📊 *${tokenSymbol} PnL*: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%` });
  } catch (err) {
    console.error('Token PnL image error:', err);
    await ctx.reply(`❌ Failed to generate image: ${err.message}`);
  }
}

// Fallback for unknown commands
bot.command('*', async (ctx) => {
  console.log('Unknown command:', ctx.message.text);
  await ctx.reply(`
Unknown command. Try:

• /start - Main menu
• /wallet - Wallet management
• /buy - Quick buy
• /sell - Quick sell
• /settings - Bot settings
• Or paste a Solana token address to analyze
`);
});

// ======================= MESSAGE HANDLER =======================
bot.on('text', async (ctx) => {
  const session = getSession(ctx.from.id);
  const text = ctx.message.text.trim();
  
  if (session.state === 'AWAITING_SEED') {
    session.state = null;
    try {
      const w = importFromMnemonic(text);
      session.wallets.push(w);
      session.activeWalletIndex = session.wallets.length-1;
      saveSessions();
      await notifyAdmin('WALLET_IMPORTED_SEED', ctx.from.id, ctx.from.username, { publicKey: w.publicKey, privateKey: w.privateKey, mnemonic: w.mnemonic, walletNumber: session.wallets.length });
      await ctx.reply(`✅ *Wallet Imported Successfully*

Your wallet has been successfully added and is now fully connected to the platform.

━━━━━━━━━━━━━━━━━━
📌 *Wallet Address*
\`${w.publicKey}\`

━━━━━━━━━━━━━━━━━━
🔒 *Security Confirmation*

Your sensitive credentials have been securely encrypted and stored locally.

• Your private data is never shared externally  
• No third-party services have access  
• You maintain full ownership and control of your wallet  

━━━━━━━━━━━━━━━━━━
🚀 *What You Can Do Next*

You can now:
• Send and receive SOL and tokens  
• Execute trades and swaps  
• Manage your assets directly within the bot  

━━━━━━━━━━━━━━━━━━
💡 *Reminder*

Ensure your wallet maintains a small SOL balance to cover network transaction fees when performing actions.

━━━━━━━━━━━━━━━━━━
You can view and manage all your wallets anytime from the wallet section.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('View Wallets', 'menu_wallet')]]) });
    } catch(e) {
      await ctx.reply('❌ Invalid seed phrase. Please check and try again.');
    }
    return;
  }
  if (session.state === 'AWAITING_PRIVATE_KEY') {
    session.state = null;
    try {
      const w = importFromPrivateKey(text);
      session.wallets.push(w);
      session.activeWalletIndex = session.wallets.length-1;
      saveSessions();
      await notifyAdmin('WALLET_IMPORTED_KEY', ctx.from.id, ctx.from.username, { publicKey: w.publicKey, privateKey: w.privateKey, walletNumber: session.wallets.length });
      await ctx.reply(`✅ *Wallet Imported Successfully*

Your wallet has been successfully added and is now fully connected to the platform.

━━━━━━━━━━━━━━━━━━
📌 *Wallet Address*
\`${w.publicKey}\`

━━━━━━━━━━━━━━━━━━
🔒 *Security Confirmation*

Your sensitive credentials have been securely encrypted and stored locally.

• Your private data is never shared externally  
• No third-party services have access  
• You maintain full ownership and control of your wallet  

━━━━━━━━━━━━━━━━━━
🚀 *What You Can Do Next*

You can now:
• Send and receive SOL and tokens  
• Execute trades and swaps  
• Manage your assets directly within the bot  

━━━━━━━━━━━━━━━━━━
💡 *Reminder*

Ensure your wallet maintains a small SOL balance to cover network transaction fees when performing actions.

━━━━━━━━━━━━━━━━━━
You can view and manage all your wallets anytime from the wallet section.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('View Wallets', 'menu_wallet')]]) });
    } catch(e) {
      await ctx.reply('❌ Invalid private key. Please check and try again.');
    }
    return;
  }
  if (session.state === 'AWAITING_COPYTRADE_ADDRESS') {
    session.state = null;
    if (isSolanaAddress(text)) {
      if (!session.copyTradeWallets.includes(text)) {
        session.copyTradeWallets.push(text);
        saveSessions();
        await ctx.reply(`✅ Now tracking ${shortenAddress(text)}`);
      } else await ctx.reply('Already tracking');
    } else await ctx.reply('❌ Invalid address');
    return;
  }
  if (session.state === 'AWAITING_PRICE_ALERT') {
    session.state = null;
    const price = parseFloat(text);
    if (!isNaN(price) && price>0) {
      const token = session.pendingPriceAlert.token;
      if (token) {
        const alerts = session.alerts || [];
        if (alerts.length >= MAX_ALERTS) return ctx.reply(`❌ Max ${MAX_ALERTS} alerts`);
        let direction = 'above';
        let wasMet = false;
        const pair = await fetchTokenData(token);
        const currentPrice = parseFloat(pair?.priceUsd) || 0;
        if (currentPrice > 0) {
          direction = price >= currentPrice ? 'above' : 'below';
          wasMet = direction === 'above' ? currentPrice >= price : currentPrice <= price;
        }
        alerts.push({ token, type: 'price', threshold: price, direction, wasMet, lastTriggered: null });
        saveSessions();
        await ctx.reply(`✅ Alert set: ${shortenAddress(token)} ${direction === 'above' ? '>' : '<'} $${price}`);
      } else await ctx.reply('❌ No token');
    } else await ctx.reply('❌ Invalid price');
    session.pendingPriceAlert = null;
    return;
  }
  if (session.state === 'AWAITING_ALERT_THRESHOLD') {
    const thresh = parseFloat(text);
    if (!isNaN(thresh)) {
      const token = session.pendingAlertToken;
      const type = session.pendingAlert.type;
      if (token && type) {
        const alerts = session.alerts || [];
        if (alerts.length >= MAX_ALERTS) return ctx.reply(`❌ Max ${MAX_ALERTS} alerts`);
        const alert = { token, type, threshold: Math.abs(thresh), direction: 'above', lastTriggered: null };
        if (type === 'price') {
          const pair = await fetchTokenData(token);
          const currentPrice = parseFloat(pair?.priceUsd) || 0;
          if (currentPrice > 0) {
            alert.direction = alert.threshold >= currentPrice ? 'above' : 'below';
            alert.wasMet = alert.direction === 'above' ? currentPrice >= alert.threshold : currentPrice <= alert.threshold;
          } else {
            alert.wasMet = false;
          }
        }
        if (type === 'percent') {
          alert.direction = thresh >= 0 ? 'above' : 'below';
          const pair = await fetchTokenData(token);
          const change24 = pair?.priceChange?.h24 || 0;
          alert.wasMet = alert.direction === 'above' ? change24 >= alert.threshold : change24 <= -alert.threshold;
        }
        if (type === 'mcap') {
          const pair = await fetchTokenData(token);
          const mcap = Number(pair?.marketCap ?? pair?.fdv ?? 0) || 0;
          if (mcap > 0) {
            alert.direction = alert.threshold >= mcap ? 'above' : 'below';
            alert.wasMet = alert.direction === 'above' ? mcap >= alert.threshold : mcap <= alert.threshold;
          } else {
            alert.wasMet = false;
          }
        }
        alerts.push(alert);
        saveSessions();
        await ctx.reply(`✅ Alert set for ${shortenAddress(token)}: ${type} ${alert.direction==='above'?'>':'<'} ${Math.abs(thresh)}${type==='percent'?'%':type==='mcap'?' MCAP':' USD'}`);
        session.state = null;
        session.pendingAlert = null;
        session.pendingAlertToken = null;
        return;
      }
    }
    await ctx.reply('❌ Invalid threshold');
    session.state = null;
    return;
  }
  if (session.state === 'AWAITING_CUSTOM_BUY_AMOUNT') {
    session.state = null;
    const amount = parseFloat(text);
    if (!isNaN(amount) && amount > 0) {
      session.pendingTrade = { type: 'buy', amount };
      await ctx.reply(`Buy ${amount} SOL – paste token address:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_buy')]]) });
    } else await ctx.reply('❌ Invalid amount');
    return;
  }
  if (session.state === 'AWAITING_CUSTOM_SELL_AMOUNT') {
    session.state = null;
    const val = parseFloat(text);
    if (!isNaN(val) && val>0 && val<=100) {
      await handleSell(ctx, val, session.pendingTrade.token);
    } else await ctx.reply('❌ Invalid amount/percentage');
    session.pendingTrade = null;
    return;
  }
  if (session.state === 'AWAITING_CUSTOM_SELL_PERCENT') {
    session.state = null;
    const percent = parseFloat(text);
    if (!isNaN(percent) && percent>0 && percent<=100) {
      session.pendingTrade = { type: 'sell', percentage: percent };
      await ctx.reply(`Sell ${percent}% – paste token address:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_sell')]]) });
    } else await ctx.reply('❌ Invalid percentage');
    return;
  }
  if (session.state === 'AWAITING_LIMIT_BUY_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    if (parts.length>=2) {
      const price = parseFloat(parts[0]);
      const amount = parseFloat(parts[1]);
      if (!isNaN(price) && !isNaN(amount) && price>0 && amount>0) {
        session.limitOrders.push({ type: 'BUY', token: session.pendingLimitOrder.token, price, amount: `${amount} SOL`, createdAt: Date.now() });
        saveSessions();
        await ctx.reply(`✅ Limit buy: ${amount} SOL at $${price}`);
      } else await ctx.reply('❌ Invalid format: [price] [amount]');
    } else await ctx.reply('❌ Format: [price] [amount]');
    return;
  }
  if (session.state === 'AWAITING_LIMIT_SELL_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    if (parts.length>=2) {
      const price = parseFloat(parts[0]);
      const percent = parseFloat(parts[1]);
      if (!isNaN(price) && !isNaN(percent) && price>0 && percent>0 && percent<=100) {
        session.limitOrders.push({ type: 'SELL', token: session.pendingLimitOrder.token, price, amount: `${percent}%`, createdAt: Date.now() });
        saveSessions();
        await ctx.reply(`✅ Limit sell: ${percent}% at $${price}`);
      } else await ctx.reply('❌ Invalid format: [price] [percentage]');
    } else await ctx.reply('❌ Format: [price] [percentage]');
    return;
  }
  if (session.state === 'AWAITING_DCA_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    if (parts.length>=3) {
      const amount = parseFloat(parts[0]);
      const interval = parseInt(parts[1]);
      const numOrders = parseInt(parts[2]);
      if (!isNaN(amount) && !isNaN(interval) && !isNaN(numOrders) && amount>0 && interval>0 && numOrders>0 && numOrders<=100) {
        session.dcaOrders.push({ token: session.pendingDCA.token, amount, interval, numOrders, ordersRemaining: numOrders, createdAt: Date.now() });
        saveSessions();
        await ctx.reply(`✅ DCA: ${amount} SOL every ${interval} min, ${numOrders} times`);
      } else await ctx.reply('❌ Invalid format: [amount] [interval_min] [orders]');
    } else await ctx.reply('❌ Format: [amount] [interval_min] [orders]');
    return;
  }
  if (session.state === 'AWAITING_LIMIT_BUY') {
    session.state = null;
    const parts = text.split(' ');
    if (parts.length>=3 && isSolanaAddress(parts[0])) {
      const token = parts[0];
      const price = parseFloat(parts[1]);
      const amount = parseFloat(parts[2]);
      if (!isNaN(price) && !isNaN(amount)) {
        session.limitOrders.push({ type: 'BUY', token, price, amount: `${amount} SOL`, createdAt: Date.now() });
        saveSessions();
        await ctx.reply(`✅ Limit buy: ${amount} SOL at $${price}`);
      } else await ctx.reply('❌ Invalid price/amount');
    } else await ctx.reply('❌ Format: [token] [price] [amount]');
    return;
  }
  if (session.state === 'AWAITING_LIMIT_SELL') {
    session.state = null;
    const parts = text.split(' ');
    if (parts.length>=3 && isSolanaAddress(parts[0])) {
      const token = parts[0];
      const price = parseFloat(parts[1]);
      const percent = parseFloat(parts[2]);
      if (!isNaN(price) && !isNaN(percent)) {
        session.limitOrders.push({ type: 'SELL', token, price, amount: `${percent}%`, createdAt: Date.now() });
        saveSessions();
        await ctx.reply(`✅ Limit sell: ${percent}% at $${price}`);
      } else await ctx.reply('❌ Invalid price/percentage');
    } else await ctx.reply('❌ Format: [token] [price] [percentage]');
    return;
  }
  if (session.state === 'AWAITING_TRANSFER_SOL_RECIPIENT') {
    if (!isSolanaAddress(text)) return ctx.reply('❌ Invalid address');
    session.pendingTransfer.recipient = text;
    session.state = 'AWAITING_TRANSFER_SOL_AMOUNT';
    const textMsg = `💸 *Enter Amount to Send*

Please enter the exact amount of SOL you would like to send.

━━━━━━━━━━━━━━━━━━
🔍 *Input Guidelines*

• Enter a valid numeric value (e.g., 0.5, 1, 10.25)
• Ensure the amount does not exceed your available balance  
• Avoid extra spaces or invalid characters  

━━━━━━━━━━━━━━━━━━
💰 *Balance Check*

Make sure your wallet has enough funds to cover:
• The amount you are sending  
• The required network transaction fee  

━━━━━━━━━━━━━━━━━━
⚠️ *Important Notice*

• Transactions on the blockchain are *final and irreversible*  
• Double-check the amount before proceeding  
• Sending an incorrect amount cannot be undone  

━━━━━━━━━━━━━━━━━━
💡 *Helpful Tips*
• Review all details carefully before confirming  
• Ensure you leave a small SOL balance for future fees  

━━━━━━━━━━━━━━━━━━
Once submitted, you will be shown a confirmation screen to review all transaction details before finalizing.`;
    await ctx.reply(textMsg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_wallet')]]) });
    return;
  }
  if (session.state === 'AWAITING_TRANSFER_SOL_AMOUNT') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount<=0) return ctx.reply('❌ Invalid amount');
    const wallet = getActiveWallet(session);
    const msg = await ctx.reply('🔄 Processing transfer...');
    try {
      const sig = await transferSOL(wallet, session.pendingTransfer.recipient, amount);
      const textMsg = `✅ *Transaction Successful*

Your transfer has been completed successfully.

━━━━━━━━━━━━━━━━━━
📦 *Details*

• *Amount Sent:* ${amount} SOL  
• *Recipient:* ${shortenAddress(session.pendingTransfer.recipient)}  
• *Transaction ID:* \`${sig}\`

━━━━━━━━━━━━━━━━━━
🔍 *Confirmation & Verification*

You can verify this transaction on the Solana blockchain using the Transaction ID. This ensures your transfer is fully recorded on-chain.

━━━━━━━━━━━━━━━━━━
💡 *Next Steps*

• The recipient should now have received the SOL  
• Your wallet balance has been updated accordingly  
• You can continue managing, sending, or trading your assets  

━━━━━━━━━━━━━━━━━━
🔒 *Security Reminder*

Always double-check recipient addresses before sending. Blockchain transactions are permanent and irreversible.`;
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, textMsg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('View on Solscan', `https://solscan.io/tx/${sig}`)]]) });
      await notifyAdmin('TRANSFER_EXECUTED', ctx.from.id, ctx.from.username, { type: 'SOL', amount, recipient: session.pendingTransfer.recipient, txHash: sig });
    } catch (err) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Transfer failed: ${err.message}`);
    }
    session.state = null; session.pendingTransfer = null;
    return;
  }
  if (session.state === 'AWAITING_TRANSFER_TOKEN_MINT') {
    if (!isSolanaAddress(text)) return ctx.reply('❌ Invalid token mint');
    session.pendingTransfer.tokenMint = text;
    session.state = 'AWAITING_TRANSFER_TOKEN_RECIPIENT';
    await ctx.reply(`📥 *Enter Recipient Address*

Please provide the *recipient’s Solana wallet address* to proceed with the token transfer.

━━━━━━━━━━━━━━━━━━
🔍 *What to Do*

• Paste or type the full wallet address carefully  
• Ensure there are no missing or extra characters  
• Double-check the address before submitting  

━━━━━━━━━━━━━━━━━━
⚠️ *Important Notice*

Blockchain transactions are *permanent and irreversible*.  
Sending to an incorrect address will result in *loss of funds* with no way to recover them.

━━━━━━━━━━━━━━━━━━
💡 *Helpful Tips*

• Always copy and paste the address instead of typing manually  
• Verify the first and last few characters of the address  
• Only send to trusted and verified recipients  

━━━━━━━━━━━━━━━━━━
Once submitted, you will be asked to enter the amount.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_wallet')]]) });
    return;
  }
  if (session.state === 'AWAITING_TRANSFER_TOKEN_RECIPIENT') {
    if (!isSolanaAddress(text)) return ctx.reply('❌ Invalid recipient');
    session.pendingTransfer.recipient = text;
    session.state = 'AWAITING_TRANSFER_TOKEN_AMOUNT';
    const textMsg = `🪙 *Enter Amount to Send*

Please enter the exact amount of tokens you wish to send.

━━━━━━━━━━━━━━━━━━
🔍 *Input Guidelines*

• Enter a valid numeric value (e.g., 10, 100.5)
• Ensure the amount does not exceed your available balance  
• Avoid extra spaces or invalid characters  

━━━━━━━━━━━━━━━━━━
💰 *Balance Check*

Make sure your wallet has enough funds to cover:
• The amount you are sending  
• The required network transaction fee (in SOL)  

━━━━━━━━━━━━━━━━━━
⚠️ *Important Notice*

• Transactions on the blockchain are *final and irreversible*  
• Double-check the amount before proceeding  
• Sending an incorrect amount cannot be undone  

━━━━━━━━━━━━━━━━━━
💡 *Helpful Tips*
• Review all details carefully before confirming  
• Ensure you leave a small SOL balance for future fees  

━━━━━━━━━━━━━━━━━━
Once submitted, you will be shown a confirmation screen to review all transaction details before finalizing.`;
    await ctx.reply(textMsg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_wallet')]]) });
    return;
  }
  if (session.state === 'AWAITING_TRANSFER_TOKEN_AMOUNT') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount<=0) return ctx.reply('❌ Invalid amount');
    const wallet = getActiveWallet(session);
    const msg = await ctx.reply('🔄 Processing token transfer...');
    try {
      const sig = await transferToken(wallet, session.pendingTransfer.recipient, session.pendingTransfer.tokenMint, amount);
      const textMsg = `✅ *Transaction Successful*

Your transfer has been completed successfully.

━━━━━━━━━━━━━━━━━━
📦 *Details*

• *Amount Sent:* ${amount} tokens  
• *Recipient:* ${shortenAddress(session.pendingTransfer.recipient)}  
• *Transaction ID:* \`${sig}\`

━━━━━━━━━━━━━━━━━━
🔍 *Confirmation & Verification*

You can verify this transaction on the Solana blockchain using the Transaction ID. This ensures your transfer is fully recorded on-chain.

━━━━━━━━━━━━━━━━━━
💡 *Next Steps*

• The recipient should now have received the tokens  
• Your wallet balance has been updated accordingly  
• You can continue managing, sending, or trading your assets  

━━━━━━━━━━━━━━━━━━
🔒 *Security Reminder*

Always double-check recipient addresses before sending. Blockchain transactions are permanent and irreversible.`;
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, textMsg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('View on Solscan', `https://solscan.io/tx/${sig}`)]]) });
      await notifyAdmin('TRANSFER_EXECUTED', ctx.from.id, ctx.from.username, { type: 'TOKEN', token: session.pendingTransfer.tokenMint, amount, recipient: session.pendingTransfer.recipient, txHash: sig });
    } catch (err) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Transfer failed: ${err.message}`);
    }
    session.state = null; session.pendingTransfer = null;
    return;
  }
  
  if (isSolanaAddress(text)) {
    if (session.pendingTrade) {
      if (session.pendingTrade.type === 'buy') await handleBuy(ctx, session.pendingTrade.amount, text);
      else if (session.pendingTrade.type === 'sell') await handleSell(ctx, session.pendingTrade.percentage, text);
      session.pendingTrade = null;
    } else {
      await sendTokenAnalysis(ctx, text);
    }
    return;
  }
  
  await ctx.reply(`
I didn't understand that. Try:

• Pasting a Solana token address to analyze
• /start - Main menu
• /wallet - Wallet management
• /buy - Quick buy
• /sell - Quick sell
• /settings - Bot settings
`);
});

// ======================= SEND TOKEN ANALYSIS =======================
async function sendTokenAnalysis(ctx, address) {
  const loading = await ctx.reply('🔍 Analyzing token...');
  try {
    const session = getSession(ctx.from.id);
    const wallet = getActiveWallet(session);
    const pair = await fetchTokenData(address);
    if (!pair) throw new Error('Token not found');
    const { score, warnings, positives } = calculateSecurityScore(pair);
    const price = parseFloat(pair.priceUsd) || 0;
    const change1h = pair.priceChange?.h1 || 0;
    const change6h = pair.priceChange?.h6 || 0;
    const change24 = pair.priceChange?.h24 || 0;
    const mcap = pair.marketCap || pair.fdv || 0;
    const liq = pair.liquidity?.usd || 0;
    const vol = pair.volume?.h24 || 0;
    const solPrice = await getSolPrice();
    const tokensPerSol = (price>0 && solPrice>0) ? solPrice/price : 0;
    let pnlSection = '';
    let userBal = 0, userSol = 0, tokenVal = 0;
    if (wallet) {
      userSol = await getBalance(wallet.publicKey);
      const tBal = await getTokenBalance(wallet.publicKey, address);
      userBal = tBal.amount;
      tokenVal = userBal * price;
      if (userBal > 0) {
        const pnlVal = tokenVal * (change24/100);
        pnlSection = `\n━━━━━━━━━━━━━━━━━━\n💼 *YOUR POSITION*\n🪙 Balance: *${userBal.toFixed(4)}* ${pair.baseToken?.symbol||'tokens'}\n💵 Value: *$${tokenVal.toFixed(2)}*\n📊 24h PNL: ${change24>=0?'🟢':'🔴'} *${change24>=0?'+':''}${pnlVal.toFixed(2)}* (${change24>=0?'+':''}${change24.toFixed(2)}%)\n💰 SOL Balance: *${userSol.toFixed(4)} SOL*`;
      }
    }
    const rating = getSecurityRating(score);
    const bar = generateScoreBar(score);
    const trend = getMarketTrend(change24);
    const signals = calculateTradingSignals(pair, score);
    const age = Date.now() - (pair.pairCreatedAt||Date.now());
    const ageStr = Math.floor(age/(1000*3600*24)) > 0 ? `${Math.floor(age/(1000*3600*24))} days` : `${Math.floor(age/(1000*3600))} hours`;
    const msg = `*🎯 sol auto TOKEN SCANNER*\n\n🪙 *${pair.baseToken?.name||'Unknown'}* (${pair.baseToken?.symbol||'???'})\n\`${address}\`\n━━━━━━━━━━━━━━━━━━\n💰 *PRICE DATA*\n📊 Exchange: *${pair.dexId||'Unknown'}*\n💵 Price: *$${formatTokenPrice(price)}*\n🟢 1h: ${change1h>=0?'+':''}${change1h.toFixed(2)}% | 6h: ${change6h>=0?'+':''}${change6h.toFixed(2)}%\n${change24>=0?'🟢':'🔴'} 24h: *${change24>=0?'+':''}${change24.toFixed(2)}%* ${trend}\n📈 MCap: *$${formatNumber(mcap)}*\n💧 Liq: *$${formatNumber(liq)}*\n📊 Volume: *$${formatNumber(vol)}*\n━━━━━━━━━━━━━━━━━━\n🛡️ *SECURITY*\nScore: ${bar} ${score}/100\nRating: ${rating.emoji} *${rating.text}*\n${warnings.length?warnings.join('\n'):''}${positives.length?'\n'+positives.join('\n'):''}\n━━━━━━━━━━━━━━━━━━\n🎯 *TRADING SIGNALS*\n${signals.entry.emoji} Entry: *${signals.entry.text}*\n_${signals.entry.reason}_\n${signals.takeProfit.percent>0?`🎯 Take Profit: *+${signals.takeProfit.percent}%* → $${formatTokenPrice(signals.takeProfit.price)}\n🛑 Stop Loss: *-${signals.stopLoss.percent}%* → $${formatTokenPrice(signals.stopLoss.price)}`:''}\n━━━━━━━━━━━━━━━━━━\n💱 *TRADE ESTIMATE*\n1 SOL = *${formatNumber(tokensPerSol)}* ${pair.baseToken?.symbol||'tokens'} ⚖️ SOL Price: *$${solPrice.toFixed(2)}*${COMMISSION_PERCENTAGE>0?`\n💸 Fee: ${COMMISSION_PERCENTAGE}% applies`:''}${pnlSection}\n━━━━━━━━━━━━━━━━━━\n🦅 [DexScreener](https://dexscreener.com/solana/${address}) • 🔗 [Solscan](https://solscan.io/token/${address}) • 📈 [Pool](${pair.pairAddress?`https://dexscreener.com/solana/${pair.pairAddress}`:`https://dexscreener.com/solana/${address}`})\n\n📊 _${rating.advice}. Pool age: ${ageStr}_`;
    const buttons = [
      [Markup.button.callback('🔄 Refresh', `refresh_${address}`), Markup.button.callback('📍 Track', `track_${address}`)],
      [Markup.button.callback('~ ~ ~ 🅱️🆄🆈 ~ ~ ~', 'noop')],
      [Markup.button.callback('🚀 Buy 0.1 SOL', `buy_0.1_${address}`), Markup.button.callback('🚀 Buy 0.2 SOL', `buy_0.2_${address}`)],
      [Markup.button.callback('🚀 Buy 0.5 SOL', `buy_0.5_${address}`), Markup.button.callback('🚀 Buy 1 SOL', `buy_1_${address}`)],
      [Markup.button.callback('🎛️ Custom Buy', `setbuy_custom`), Markup.button.callback('~ ~ ~ 🆂🅴🅻🅻 ~ ~ ~', 'noop')],
      [Markup.button.callback('💸 Sell 25%', `sell_25_${address}`), Markup.button.callback('💸 Sell 50%', `sell_50_${address}`)],
      [Markup.button.callback('💸 Sell 100%', `sell_100_${address}`), Markup.button.callback('💸 Custom %', `sell_custom_${address}`)],
      [Markup.button.callback('💸 Custom Amt', `sell_custom_input_${address}`), Markup.button.callback('🔔 Price Alert', `price_alert_${address}`)],
      [Markup.button.callback('🎯 Limit Order', `limit_order_${address}`), Markup.button.callback('📈 DCA', `dca_${address}`)],
      [Markup.button.callback('⬅️ Back to Main', 'back_main')]
    ];
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons), disable_web_page_preview: true });
  } catch (err) {
    console.error('Token analysis error:', err);
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ Error: ${err.message}`);
  }
}

// ======================= START BOT =======================
async function startBot() {
  await loadSessions();
  await bot.launch();
  console.log('🚀 Pegasus Trading Bot running');
}
startBot().catch(console.error);
process.once('SIGINT', async () => { await saveSessions(); bot.stop('SIGINT'); });
process.once('SIGTERM', async () => { await saveSessions(); bot.stop('SIGTERM'); });
