/**
 * Buscador de Cremas: descubrimiento de productos/precios desde páginas públicas.
 * - Sin CSV, API de pago ni claves.
 * - Solo dominios explícitamente permitidos abajo.
 * - Lee robots.txt, sitemap(s), limita peticiones y respeta 429/403.
 * - Solo interpreta JSON-LD Product/Offer publicado por la tienda.
 * Nota: robots.txt no equivale a permiso legal universal; revisa las condiciones de cada tienda.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const productsPath = new URL('../data/products.json', import.meta.url);
const pricesPath = new URL('../data/prices.json', import.meta.url);
const statusPath = new URL('../data/update-status.json', import.meta.url);
const USER_AGENT = 'BuscadorDeCremasBot/1.2 (+https://github.com/; price comparison; contact repo maintainer)';
const MAX_SITEMAPS_PER_STORE = 12;
const MAX_PRODUCT_PAGES_PER_STORE = 50;
const MAX_CATEGORY_SEEDS_PER_STORE = 4;
const REQUEST_DELAY_MS = 1200;
const PRODUCT_WORDS = /crema|cream|facial|anti.?arrugas|anti.?edad|anti.?age|retinol|lifting|reafirm|col[aá]geno|hialur[oó]nico|contorno.?de.?ojos|noche|d[ií]a|hidratante|moistur|firming|wrinkle|age.?perfect|revitalift|hyaluron/i;
const TARGET_WORDS = /crema|cream|facial|anti.?arrugas|anti.?edad|anti.?age|retinol|lifting|reafirm|col[aá]geno|hialur[oó]nico|contorno.?de.?ojos|noche|d[ií]a|hidratante|moistur|firming|wrinkle/i;
// Solo se intentan estas tiendas. Añade una tienda únicamente tras comprobar sus condiciones y robots.txt.
const STORES = [
  { name: 'Primor', host: 'www.primor.eu', home: 'https://www.primor.eu/' },
  { name: 'Druni', host: 'www.druni.es', home: 'https://www.druni.es/', categorySeeds: ['https://www.druni.es/cosmetica/facial', 'https://www.druni.es/cosmetica/facial/antiedad', 'https://www.druni.es/cosmetica/facial/nutritiva', 'https://www.druni.es/cosmetica/cremas'] },
  { name: 'Douglas', host: 'www.douglas.es', home: 'https://www.douglas.es/' },
  { name: 'Arenal', host: 'www.arenal.com', home: 'https://www.arenal.com/' },
  { name: 'Atida', host: 'www.atida.com', home: 'https://www.atida.com/' },
  { name: 'Notino', host: 'www.notino.es', home: 'https://www.notino.es/', categorySeeds: ['https://www.notino.es/cremas-hidratantes/'] },
  { name: "Perfume's Club", host: 'www.perfumesclub.com', home: 'https://www.perfumesclub.com/', categorySeeds: ['https://www.perfumesclub.com/es/cosmetica-facial/f/'] },
  { name: 'El Corte Inglés', host: 'www.elcorteingles.es', home: 'https://www.elcorteingles.es/', categorySeeds: ['https://www.elcorteingles.es/belleza/'] },
];
const sleepBetween = () => sleep(REQUEST_DELAY_MS);
const normal = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slug = s => normal(s).replace(/\s+/g, '-').slice(0, 75) || 'producto';
const text = v => typeof v === 'string' ? v.trim() : (v == null ? '' : String(v));
const asArray = v => Array.isArray(v) ? v : (v == null ? [] : [v]);
const safeUrl = (raw, base) => { try { const u = new URL(raw, base); return u.protocol === 'https:' ? u : null; } catch { return null; } };

async function get(url, store, timeoutMs=18000) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== store.host) throw new Error('dominio fuera de la lista permitida');
  await sleepBetween();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(u, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': USER_AGENT, 'accept': 'text/html,application/xml,text/xml,*/*;q=0.8' } });
    if (res.url) { const final = new URL(res.url); if (final.hostname !== store.host || final.protocol !== 'https:') throw new Error('redirección a otro dominio bloqueada'); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text(), type: res.headers.get('content-type') || '' };
  } finally { clearTimeout(timer); }
}

function parseRobots(txt, origin) {
  const lines = txt.split(/\r?\n/); let applies = false; const disallow = [], allow = [], sitemaps=[];
  for (const raw of lines) {
    const line = raw.split('#')[0].trim(); if (!line || !line.includes(':')) continue;
    const i=line.indexOf(':'); const key=line.slice(0,i).trim().toLowerCase(); const value=line.slice(i+1).trim();
    if (key==='user-agent') applies = value==='*' || /buscadordecremasbot/i.test(value);
    else if (key==='sitemap' && value) { const u=safeUrl(value, origin); if(u && u.origin===origin) sitemaps.push(u.href); }
    else if (applies && key==='disallow' && value) disallow.push(value);
    else if (applies && key==='allow' && value) allow.push(value);
  }
  return { disallow, allow, sitemaps };
}
function allowedPath(path, rules) {
  // Robots wildcard/end-anchor support is intentionally conservative and small.
  const match = rule => { const escaped=rule.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\$$/,'$'); try{return new RegExp('^'+escaped).test(path)}catch{return path.startsWith(rule)} };
  const blocked=rules.disallow.filter(match).sort((a,b)=>b.length-a.length)[0];
  const permitted=rules.allow.filter(match).sort((a,b)=>b.length-a.length)[0];
  return !blocked || (permitted && permitted.length>=blocked.length);
}
function parseLocs(xml, base) {
  const out=[]; for(const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)){const u=safeUrl(m[1].replace(/&amp;/g,'&'),base);if(u)out.push(u.href)} return out;
}
function parseRelevantLinks(html, pageUrl, store) {
  const candidates=[];
  for (const m of html.matchAll(/<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href=m[1].replace(/&amp;/g,'&');
    const label=m[2].replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
    const u=safeUrl(href,pageUrl); if(!u || u.hostname!==store.host) continue;
    if(u.pathname===new URL(pageUrl).pathname || /\.(jpg|jpeg|png|webp|svg|pdf|css|js)$/i.test(u.pathname)) continue;
    if(u.search && !/product|producto|variant|sku/i.test(u.search)) continue;
    const path=u.pathname+u.search;
    if(!allowedPath(path,store.robotsRules)) continue;
    // Prioriza enlaces que parecen productos; admite slugs sin palabras cosméticas porque
    // algunas tiendas usan IDs o nombres de gama en la URL. La ficha debe validar después
    // que sea Product/ProductGroup y que publique un precio EUR.
    const productLike = PRODUCT_WORDS.test(path) || PRODUCT_WORDS.test(label) || /\/p\/|\/product|\/producto|\.html$/i.test(u.pathname) || u.pathname.split('/').filter(Boolean).length >= 3;
    if(productLike) candidates.push({url:u.href, score:(PRODUCT_WORDS.test(path+' '+label)?3:0)+(/\.html$/i.test(u.pathname)?1:0)+u.pathname.split('/').filter(Boolean).length/100});
  }
  const unique=new Map();
  for(const c of candidates){const old=unique.get(c.url);if(!old||c.score>old.score)unique.set(c.url,c)}
  return [...unique.values()].sort((a,b)=>b.score-a.score).map(x=>x.url).slice(0,200);
}
function collectJsonLd(html) {
  const out=[];
  for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const val=JSON.parse(m[1].replace(/&quot;/g,'"').trim()); const walk=x=>{ if(!x||typeof x!=='object')return; if(Array.isArray(x)){x.forEach(walk);return} const types=asArray(x['@type']).map(String); if(types.some(t=>['Product','ProductGroup'].includes(t)))out.push(x); if(x['@graph'])walk(x['@graph']); }; walk(val); } catch {}
  }
  return out;
}
function extractOffer(product) {
  const offers=asArray(product.offers).flatMap(x=>x && x['@type']==='AggregateOffer' ? asArray(x.offers) : [x]);
  const valid=offers.map(o=>({ price:Number(text(o?.price ?? o?.lowPrice).replace(',','.')), currency:text(o?.priceCurrency)||'EUR', availability:text(o?.availability), url:text(o?.url) })).filter(o=>Number.isFinite(o.price)&&o.price>0&&o.currency==='EUR');
  if(!valid.length)return null;
  valid.sort((a,b)=>a.price-b.price);return valid[0];
}
function brandName(p) { const b=p.brand; return typeof b==='string'?b:text(b?.name)||text(p.manufacturer?.name)||'Marca no indicada'; }
function extractProduct(p, pageUrl, store) {
  const name=text(p.name).replace(/\s+/g,' '); if(!name || !PRODUCT_WORDS.test(name))return null;
  const offer=extractOffer(p); if(!offer)return null;
  const link=safeUrl(offer.url || pageUrl,pageUrl); if(!link || link.hostname!==store.host)return null;
  const brand=brandName(p); const key=normal(`${brand} ${name}`); const id='auto-'+slug(`${brand} ${name}`);
  const rawDescription = text(p.description || p.disambiguatingDescription || p.additionalProperty?.description).replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'\"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim();
  const description = rawDescription ? rawDescription.slice(0,900) : `${name}: consulta la descripción y las indicaciones del fabricante para conocer su función, modo de uso y tipo de piel recomendado. La información específica no estaba publicada en los datos estructurados de la tienda.`;
  return { id, brand, name, category:'crema facial', benefit:rawDescription ? rawDescription.slice(0,150) : 'Consulta la ficha del fabricante para conocer sus beneficios.', skinTypes:[], ingredients:[], ageGuide:'Consulta las indicaciones del fabricante', description, image: safeUrl(asArray(p.image)[0]?.url || asArray(p.image)[0] || p.image, pageUrl)?.href || '', sourceUrl: pageUrl, matchKey:key,
    offer:{ product_id:id, store:store.name, price:Math.round(offer.price*100)/100, currency:'EUR', url:link.href, availability:offer.availability, checked_at:new Date().toISOString() } };
}
async function processStore(store) {
  const errors=[]; let robots; let robotsUrl=new URL('/robots.txt',store.home).href; let categoryLinksFound=0; let categorySeedsSkipped=0; let jsonLdProductsFound=0;
  try { const r=await get(robotsUrl,store); robots=parseRobots(r.text,new URL(store.home).origin); }
  catch(e){ return { store:store.name, found:0, offers:[], products:[], error:`No se pudo leer robots.txt (${e.message}); tienda omitida por seguridad.` }; }
  const origin=new URL(store.home).origin; store.robotsRules=robots; const sitemapQueue=[...new Set(robots.sitemaps)];
  if(!sitemapQueue.length && !(store.categorySeeds||[]).length) return {store:store.name,found:0,offers:[],products:[],error:'robots.txt no publica sitemaps y no hay categorías configuradas.'};
  const seenMaps=new Set(), productUrls=[];
  while(sitemapQueue.length && seenMaps.size<MAX_SITEMAPS_PER_STORE && productUrls.length<MAX_PRODUCT_PAGES_PER_STORE*4){
    const mapUrl=sitemapQueue.shift(); if(seenMaps.has(mapUrl))continue; seenMaps.add(mapUrl);
    try { const r=await get(mapUrl,store); const locs=parseLocs(r.text,mapUrl); const isIndex=/<sitemapindex\b/i.test(r.text);
      if (isIndex) {
        for (const loc of locs) { if (new URL(loc).hostname===store.host && !seenMaps.has(loc)) sitemapQueue.push(loc); }
      } else {
        for (const loc of locs) { const u=new URL(loc); if(u.hostname!==store.host||!allowedPath(u.pathname+u.search,robots)) continue; if(TARGET_WORDS.test(u.pathname)) productUrls.push(u.href); }
      }
    } catch(e){errors.push(`${new URL(mapUrl).pathname}: ${e.message}`)}
  }
  // Algunas tiendas, especialmente Druni, pueden tener sitemaps difíciles de recorrer o URLs de producto sin palabras clave.
  // Como complemento, leer unas pocas categorías públicas permitidas por robots.txt y extraer enlaces relevantes.
  for (const seed of (store.categorySeeds||[]).slice(0,MAX_CATEGORY_SEEDS_PER_STORE)) {
    try {
      const u=new URL(seed);
      if(u.hostname!==store.host) continue;
      if(!allowedPath(u.pathname+u.search,robots)){categorySeedsSkipped++;continue;}
      const r=await get(seed,store);
      const categoryLinks=parseRelevantLinks(r.text,seed,store); categoryLinksFound+=categoryLinks.length; productUrls.push(...categoryLinks);
      // También leer datos estructurados que algunas categorías publican directamente.
      for(const p of collectJsonLd(r.text)){ jsonLdProductsFound++; const item=extractProduct(p,seed,store); if(item){ /* category listing data is handled as an offer below */ productUrls.push(item.sourceUrl); } }
    } catch(e) { errors.push(`categoría ${new URL(seed).pathname}: ${e.message}`); }
  }
  const uniqueUrls=[...new Set(productUrls)].slice(0,MAX_PRODUCT_PAGES_PER_STORE); const products=[],offers=[];
  for(const url of uniqueUrls){
    try { const u=new URL(url); if(!allowedPath(u.pathname+u.search,robots))continue; const r=await get(url,store); if(!/html/i.test(r.type) && !/<html/i.test(r.text.slice(0,5000)))continue;
      for(const p of collectJsonLd(r.text)){jsonLdProductsFound++;const item=extractProduct(p,url,store);if(item){products.push(item);offers.push(item.offer)}}
    } catch(e){errors.push(`${new URL(url).pathname}: ${e.message}`);if(/HTTP 403|HTTP 429/.test(e.message))break;}
  }
  const byKey=new Map();for(const p of products)byKey.set(p.matchKey,p);
  const diagnostics=`diagnóstico: enlacesCategoría=${categoryLinksFound}, JSON-LD Product=${jsonLdProductsFound}, categorías omitidas por robots=${categorySeedsSkipped}`;
  return {store:store.name,found:byKey.size,offers:[...byKey.values()].map(x=>x.offer),products:[...byKey.values()],error:[...errors.slice(0,3),diagnostics].join(' | ')||null};
}

const baseProducts=JSON.parse(await readFile(productsPath,'utf8'));
const oldPrices=JSON.parse(await readFile(pricesPath,'utf8').catch(()=>'{"offers":[]}'));
const reports=[]; const discovered=[];
for(const store of STORES){ reports.push(await processStore(store)); discovered.push(...reports.at(-1).products); }
// Merge seeded catalogue with automatically discovered products. Match by normalized brand/name to avoid duplicates.
const products=[...baseProducts]; const productKey=p=>normal(`${p.brand} ${p.name}`); const byKey=new Map(products.map(p=>[productKey(p),p]));
const discoveredOffers=[];
for(const d of discovered){
  let target=byKey.get(productKey(d));
  if(!target){const {offer,matchKey,...product}=d;target=product;products.push(target);byKey.set(productKey(target),target);}
  // If an auto-discovered product matches a seed product, attach the offer to the existing stable ID.
  if(d.offer) discoveredOffers.push({...d.offer, product_id:target.id});
}
// Keep existing offers only when still less than 48h old; new crawl values replace the same store/product pair.
const now=Date.now(); const freshOld=(oldPrices.offers||[]).filter(o=>o.checked_at && now-new Date(o.checked_at).getTime()<48*60*60*1000 && !STORES.some(s=>s.name===o.store));
const currentOffers=[...freshOld,...discoveredOffers];
const offerMap=new Map();for(const o of currentOffers){const key=`${o.product_id}|${o.store}|${o.url}`;const prev=offerMap.get(key);if(!prev||String(o.checked_at)>String(prev.checked_at))offerMap.set(key,o)}
const successes=reports.filter(r=>!r.error||r.found>0).length;
const prices={updatedAt:new Date().toISOString(),currency:'EUR',offers:[...offerMap.values()],source:'Datos estructurados públicos de páginas de tiendas; sujeto a disponibilidad y condiciones de acceso.',note:'Solo se publican precios encontrados en páginas accesibles. Ausencia de ofertas no significa ausencia de producto en la tienda.'};
const status={updatedAt:prices.updatedAt,stores:reports.map(({store,found,error})=>({store,productsFound:found,error})),discoveredProducts:discovered.length,offers:prices.offers.length,limitations:['El rastreo combina sitemaps públicos y categorías permitidas; limita el número de páginas por tienda. El estado incluye contadores de diagnóstico por tienda.','Las tiendas pueden bloquear o cambiar sus páginas; 403/429 se respetan y no se evaden.','Solo se leen precios JSON-LD publicados; páginas sin esos datos no aportarán precios.','Comprueba las condiciones de cada tienda antes de usarlo públicamente.']};
await writeFile(productsPath,JSON.stringify(products,null,2)+'\n');
await writeFile(pricesPath,JSON.stringify(prices,null,2)+'\n');
await writeFile(statusPath,JSON.stringify(status,null,2)+'\n');
console.log(JSON.stringify({products:products.length,offers:prices.offers.length,stores:status.stores},null,2));
