/**
 * update_CR.js
 * ---------------------------------------------------------------------------
 * Télécharge l'archive des comptes rendus intégraux (syceron brut) de
 * l'Assemblée nationale, et n'en extrait que les débats dont la séance
 * (seanceRef) correspond à un scrutin présent dans votes.json (à la racine
 * du repository).
 *
 * Mode incrémental : un fichier JSON est écrit par séance dans le dossier
 * CR/ (ex: CR/RUANR5L17S2025IDS28584.json). Seules les séances qui n'ont
 * pas encore de fichier correspondant sont traitées. Si toutes les séances
 * référencées dans votes.json ont déjà leur fichier, l'archive n'est même
 * pas téléchargée.
 *
 * Cela évite de recommitter un unique gros fichier à chaque exécution
 * (problème de taille sur GitHub) : chaque run n'ajoute que quelques
 * petits fichiers neufs.
 *
 * Pour chaque séance, seules les données utiles à la génération d'un
 * résumé neutre des débats sont extraites :
 *   - identité de la séance (uid, seanceRef, date, session, légisature)
 *   - sommaire des sujets abordés (titres des points à l'ordre du jour)
 *   - pour chaque sujet : la liste des interventions (orateur, fonction,
 *     rôle en séance, texte prononcé)
 *
 * Sortie : CR/<seanceRef>.json (un fichier par séance).
 *
 * Dépendances (npm) :
 *   npm install adm-zip
 *
 * Utilisation :
 *   node update_CR.js
 *
 * Prérequis : Node.js 18+ (fetch natif).
 * ---------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const ZIP_URL =
  'https://data.assemblee-nationale.fr/static/openData/repository/17/vp/syceronbrut/syseron.xml.zip';

const ROOT_DIR = __dirname;
const VOTE_JSON_PATH = path.join(ROOT_DIR, 'votes.json');
const CR_DIR = path.join(ROOT_DIR, 'CR');
const TMP_ZIP_PATH = path.join(ROOT_DIR, '.tmp_syseron.xml.zip');

/** Nom de fichier sûr pour un seanceRef (au cas où). */
function seanceRefToFilename(seanceRef) {
  return `${seanceRef.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

// -----------------------------------------------------------------------
// Utilitaires texte
// -----------------------------------------------------------------------

/**
 * Décode les entités XML de base et nettoie les balises inline
 * (<br/>, <italique>...</italique>) pour ne conserver que du texte brut,
 * lisible et exploitable par un résumeur (LLM ou autre).
 */
function toPlainText(rawXmlFragment) {
  if (!rawXmlFragment) return '';

  let text = rawXmlFragment
    // saut de ligne explicite
    .replace(/<br\s*\/?>/gi, '\n')
    // on garde le contenu des balises de mise en forme, on retire juste la balise
    .replace(/<\/?italique>/gi, '')
    .replace(/<\/?gras>/gi, '')
    .replace(/<\/?souligne>/gi, '')
    // toute autre balise résiduelle est supprimée (contenu conservé)
    .replace(/<[^>]+>/g, '');

  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractAttr(attrString, name) {
  const m = attrString.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function extractTag(block, tag) {
  // Le lookahead (?=[\s/>]) évite les faux positifs entre deux balises dont
  // le nom de l'une est préfixe de l'autre (ex: <session> vs <sessionRef>).
  const m = block.match(new RegExp(`<${tag}(?=[\\s/>])[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1] : null;
}

/**
 * Extrait les blocs <tagName ...>...</tagName> de plus haut niveau (non
 * imbriqués les uns dans les autres) d'un texte, en tenant compte de
 * l'imbrication réelle de la balise (profondeur).
 *
 * Nécessaire car les comptes rendus AN imbriquent des <point> les uns dans
 * les autres (ex: un point "article" contient des points "amendement"),
 * alors que d'autres <point> de même nom sont de simples frères. Un simple
 * regex non-gourmand se referme sur la première balise fermante rencontrée
 * — donc sur celle d'un enfant — ce qui tronque et corrompt le contenu.
 * Cette fonction referme chaque bloc sur sa véritable balise fermante, en
 * conservant tout son contenu imbriqué intact (utile ensuite : les
 * <paragraphe> internes, à n'importe quelle profondeur, restent présents).
 */
function extractTopLevelBlocks(text, tagName) {
  const blocks = [];
  const tagRegex = new RegExp(`<${tagName}\\b([^>]*)>|<\\/${tagName}>`, 'g');
  let depth = 0;
  let startAttrs = null;
  let startContentIdx = null;
  let m;
  while ((m = tagRegex.exec(text)) !== null) {
    const isClosing = m[0].startsWith('</');
    if (!isClosing) {
      if (depth === 0) {
        startAttrs = m[1];
        startContentIdx = tagRegex.lastIndex;
      }
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ attrs: startAttrs, content: text.slice(startContentIdx, m.index) });
      }
    }
  }
  return blocks;
}

/**
 * Extrait un nombre annoncé sous forme "Libellé : 123" dans le texte d'une
 * intervention (insensible à la casse, tolérant sur la ponctuation).
 */
function extractLabeledNumber(text, labelPattern) {
  const m = text.match(new RegExp(`${labelPattern}\\s*:?\\s*(\\d+)`, 'i'));
  return m ? Number(m[1]) : null;
}

/**
 * Détecte si le texte d'une intervention est une annonce de résultat de
 * scrutin, et en extrait les décomptes.
 *
 * NB : le CR brut (syceron) n'expose pas de numéro de scrutin officiel dans
 * le texte — seul le fichier votes.json (dataset "Scrutins") le connaît. La
 * détection repose donc sur la formule standard utilisée par l'Assemblée
 * nationale pour annoncer un résultat ("Nombre de votants", "Nombre de
 * suffrages exprimés", "Pour l'adoption", "Contre"). Si cette formule venait
 * à changer, adapter les patterns ci-dessous.
 */
function extractScrutinResult(plainText, ordreAbsoluSeance) {
  if (!/nombre\s+de\s+votants/i.test(plainText)) return null;

  const votants = extractLabeledNumber(plainText, "nombre\\s+de\\s+votants");
  const exprimes = extractLabeledNumber(plainText, "suffrages\\s+exprim[ée]s");
  const majoriteAbsolue = extractLabeledNumber(plainText, "majorit[ée]\\s+absolue");
  const pour = extractLabeledNumber(plainText, "pour\\s+l['’]adoption");
  const contre = extractLabeledNumber(plainText, "contre");

  if (votants === null && pour === null && contre === null) return null;

  return {
    ordre: ordreAbsoluSeance !== null && ordreAbsoluSeance !== undefined ? Number(ordreAbsoluSeance) : null,
    votants,
    exprimes,
    majoriteAbsolue,
    pour,
    contre,
    abstention: votants !== null && exprimes !== null ? votants - exprimes : null,
  };
}

// -----------------------------------------------------------------------
// Parsing d'un fichier compte-rendu (XML brut, en chaîne de caractères)
// -----------------------------------------------------------------------

/**
 * Extrait rapidement le seanceRef d'un CR, sans parser tout le document.
 * Sert de filtre peu coûteux avant le parsing complet.
 */
function quickExtractSeanceRef(xmlText) {
  const m = xmlText.match(/<seanceRef>([^<]+)<\/seanceRef>/);
  return m ? m[1].trim() : null;
}

/**
 * Convertit une dateSeance au format AAAAMMJJhhmmssSSS en date ISO (AAAA-MM-JJ),
 * pour pouvoir être croisée facilement avec le champ "date" de votes.json.
 */
function toIsoDate(dateSeanceRaw) {
  if (!dateSeanceRaw || dateSeanceRaw.length < 8) return null;
  const y = dateSeanceRaw.slice(0, 4);
  const m = dateSeanceRaw.slice(4, 6);
  const d = dateSeanceRaw.slice(6, 8);
  return `${y}-${m}-${d}`;
}

/**
 * Parse un bloc <paragraphe ...>...</paragraphe> = une intervention.
 */
function parseParagraphe(attrsRaw, block) {
  const roledebat = extractAttr(attrsRaw, 'roledebat'); // ex: "president"
  const idActeur = extractAttr(attrsRaw, 'id_acteur');
  const ordreAbsoluSeance = extractAttr(attrsRaw, 'ordre_absolu_seance');

  const orateursBlock = extractTag(block, 'orateurs') || '';
  const nom = extractTag(orateursBlock, 'nom');
  const qualiteRaw = extractTag(orateursBlock, 'qualite');

  const texteRaw = extractTag(block, 'texte');
  const texte = toPlainText(texteRaw);

  // On ignore les interventions vides (ex: didascalies pures sans intérêt)
  if (!texte) return null;

  const intervention = {
    orateur: nom ? toPlainText(nom) : null,
    fonction: qualiteRaw ? toPlainText(qualiteRaw) : null,
    role: roledebat || null, // ex: "president" si c'est le/la président(e) de séance
    idActeur: idActeur || null,
    ordre: ordreAbsoluSeance !== null ? Number(ordreAbsoluSeance) : null, // position chronologique dans la séance
    texte,
  };

  // Si cette intervention annonce le résultat d'un scrutin, on le mémorise
  // (sera rapproché d'une entrée de votes.json dans matchScrutinsToVotes).
  const scrutinDetecte = extractScrutinResult(texte, ordreAbsoluSeance);
  if (scrutinDetecte) intervention.scrutinDetecte = scrutinDetecte;

  return intervention;
}

/**
 * Parse un bloc <point ...>...</point> = un sujet à l'ordre du jour,
 * regroupant toutes les interventions qui s'y rattachent.
 */
function parsePoint(attrsRaw, block) {
  const valeurPtsOdj = extractAttr(attrsRaw, 'valeur_ptsodj');
  const idSyceron = extractAttr(attrsRaw, 'id_syceron');

  // Le titre du point est le premier <texte> du bloc, avant toute <paragraphe>.
  const titreMatch = block.match(/<texte>([\s\S]*?)<\/texte>/);
  const titre = titreMatch ? toPlainText(titreMatch[1]) : null;

  const interventions = [];
  const scrutinsBruts = []; // résultats de scrutin détectés dans ce point, non encore rapprochés de votes.json
  const paragrapheRegex = /<paragraphe\s+([^>]*)>([\s\S]*?)<\/paragraphe>/g;
  let pMatch;
  while ((pMatch = paragrapheRegex.exec(block)) !== null) {
    const intervention = parseParagraphe(pMatch[1], pMatch[2]);
    if (intervention) {
      interventions.push(intervention);
      if (intervention.scrutinDetecte) {
        scrutinsBruts.push(intervention.scrutinDetecte);
      }
    }
  }

  // On ignore les points purement procéduraux, sans aucune intervention exploitable.
  if (interventions.length === 0) return null;

  return {
    idSyceron: idSyceron || null,
    valeurPtsOdj: valeurPtsOdj || null,
    titre,
    interventions,
    scrutinsBruts, // champ intermédiaire, résolu puis retiré par matchScrutinsToVotes
  };
}

/**
 * Parse un compte-rendu complet et retourne uniquement les données
 * pertinentes pour l'analyse/résumé des débats.
 */
function parseCompteRendu(xmlText) {
  const uid = extractTag(xmlText, 'uid');
  const seanceRef = extractTag(xmlText, 'seanceRef');
  const sessionRef = extractTag(xmlText, 'sessionRef');

  const dateSeanceRaw = extractTag(xmlText, 'dateSeance');
  const dateSeanceJour = extractTag(xmlText, 'dateSeanceJour');
  const session = extractTag(xmlText, 'session');
  const legislature = extractTag(xmlText, 'legislature');

  // On ne s'intéresse qu'aux <point> de plus haut niveau à l'intérieur de
  // <contenu> : les points imbriqués (ex: amendements dans un article) sont
  // conservés dans le contenu de leur point parent et fusionnés avec lui
  // (voir extractTopLevelBlocks).
  const contenuMatch = xmlText.match(/<contenu(?=[\s>])[^>]*>([\s\S]*)<\/contenu>/);
  const contenuText = contenuMatch ? contenuMatch[1] : xmlText;

  const points = [];
  for (const { attrs, content } of extractTopLevelBlocks(contenuText, 'point')) {
    const point = parsePoint(attrs, content);
    if (point) points.push(point);
  }

  return {
    uid,
    seanceRef,
    sessionRef,
    date: toIsoDate(dateSeanceRaw),
    dateLisible: dateSeanceJour ? toPlainText(dateSeanceJour) : null,
    session: session ? toPlainText(session) : null,
    legislature: legislature ? legislature.trim() : null,
    sujets: points,
  };
}

// -----------------------------------------------------------------------
// Rapprochement des scrutins du CR avec les votes de votes.json
// -----------------------------------------------------------------------

/**
 * Compare les décomptes d'un scrutin détecté dans le CR avec ceux d'une
 * entrée de votes.json. Ne compare que les champs disponibles des deux
 * côtés (tolérant si l'un des deux est absent).
 */
function tallyMatches(scrutinBrut, vote) {
  const sv = vote.syntheseVote || {};
  if (scrutinBrut.pour !== null && sv.pour !== undefined && scrutinBrut.pour !== sv.pour) return false;
  if (scrutinBrut.contre !== null && sv.contre !== undefined && scrutinBrut.contre !== sv.contre) return false;
  if (scrutinBrut.votants !== null && sv.total !== undefined && scrutinBrut.votants !== sv.total) return false;
  return true;
}

/**
 * Méthode robuste décrite pour associer chaque scrutin détecté dans le CR
 * à son numéro officiel :
 *  1. On prend tous les scrutins du CR (tous points confondus) triés par
 *     ordre chronologique (ordre_absolu_seance).
 *  2. On prend tous les votes de votes.json pour ce seanceRef, triés par
 *     numero croissant.
 *  3. On tente d'abord une correspondance exacte par tallies (votants,
 *     pour, contre) — la plus fiable.
 *  4. Pour les scrutins restants (non désambiguïsés par les tallies), on
 *     complète par appariement positionnel (n-ième scrutin du CR <->
 *     n-ième vote non encore utilisé), qui reflète l'ordre chronologique
 *     de la séance.
 *
 * Le résultat est attaché à chaque point concerné sous point.scrutins,
 * et le champ intermédiaire scrutinsBruts est retiré.
 */
function matchScrutinsToVotes(compteRendu, votesForSeance) {
  const allScrutins = [];
  compteRendu.sujets.forEach((point, pointIndex) => {
    (point.scrutinsBruts || []).forEach((s) => {
      allScrutins.push({ ...s, pointIndex });
    });
  });
  allScrutins.sort((a, b) => (a.ordre ?? 0) - (b.ordre ?? 0));

  const votesSorted = [...votesForSeance].sort((a, b) => (a.numero ?? 0) - (b.numero ?? 0));
  const usedVoteIds = new Set();
  const matchedPairs = new Map(); // index dans allScrutins -> vote

  // 1) correspondance exacte par tallies, uniquement si non ambiguë
  allScrutins.forEach((s, i) => {
    const candidates = votesSorted.filter((v) => !usedVoteIds.has(v.id) && tallyMatches(s, v));
    if (candidates.length === 1) {
      matchedPairs.set(i, candidates[0]);
      usedVoteIds.add(candidates[0].id);
    }
  });

  // 2) fallback positionnel/chronologique pour les scrutins restants
  const unresolvedIdx = allScrutins.map((_, i) => i).filter((i) => !matchedPairs.has(i));
  const unusedVotes = votesSorted.filter((v) => !usedVoteIds.has(v.id));
  unresolvedIdx.forEach((idx, k) => {
    const vote = unusedVotes[k];
    if (vote) {
      matchedPairs.set(idx, vote);
      usedVoteIds.add(vote.id);
    }
  });

  compteRendu.sujets.forEach((point) => {
    point.scrutins = [];
  });

  allScrutins.forEach((s, i) => {
    const vote = matchedPairs.get(i) || null;
    const point = compteRendu.sujets[s.pointIndex];
    point.scrutins.push({
      numero: vote ? vote.numero : null,
      id: vote ? vote.id : null,
      sort: vote ? vote.sort : null,
      titreVote: vote ? vote.titre : null,
      // "exact" = tallies identiques confirmés, "ordre_probable" = déduit du
      // seul rang chronologique (à vérifier si l'ordre du CR diverge des tallies)
      matchConfidence: vote ? (tallyMatches(s, vote) ? 'exact' : 'ordre_probable') : 'non_trouve',
      votants: s.votants,
      exprimes: s.exprimes,
      pour: s.pour,
      contre: s.contre,
      abstention: s.abstention,
      ordre: s.ordre,
    });
  });

  compteRendu.sujets.forEach((point) => {
    delete point.scrutinsBruts;
  });

  return compteRendu;
}

// -----------------------------------------------------------------------
// Étapes principales
// -----------------------------------------------------------------------

async function downloadZip(url, destPath) {
  console.log(`Téléchargement de l'archive : ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Échec du téléchargement (${response.status} ${response.statusText})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  console.log(`Archive enregistrée : ${destPath}`);
}

function loadVotes(votePath) {
  if (!fs.existsSync(votePath)) {
    throw new Error(`Fichier introuvable : ${votePath}`);
  }
  return JSON.parse(fs.readFileSync(votePath, 'utf8'));
}

/** Regroupe les votes par seanceRef, triés par numero croissant. */
function groupVotesBySeance(votes) {
  const map = new Map();
  for (const vote of votes) {
    if (!vote.seanceRef) continue;
    if (!map.has(vote.seanceRef)) map.set(vote.seanceRef, []);
    map.get(vote.seanceRef).push(vote);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.numero ?? 0) - (b.numero ?? 0));
  }
  return map;
}

async function main() {
  const votes = loadVotes(VOTE_JSON_PATH);
  const votesBySeance = groupVotesBySeance(votes);
  const targetSeanceRefs = new Set(votesBySeance.keys());

  if (!fs.existsSync(CR_DIR)) {
    fs.mkdirSync(CR_DIR, { recursive: true });
  }

  // Séances déjà extraites lors d'un run précédent (mode incrémental)
  const alreadyDone = new Set(
    fs
      .readdirSync(CR_DIR)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => f.replace(/\.json$/i, ''))
  );

  const missingSeanceRefs = new Set(
    [...targetSeanceRefs].filter((ref) => !alreadyDone.has(seanceRefToFilename(ref).replace(/\.json$/i, '')))
  );

  console.log(`${targetSeanceRefs.size} séance(s) référencée(s) dans votes.json`);
  console.log(`${alreadyDone.size} séance(s) déjà présente(s) dans ${path.basename(CR_DIR)}/`);
  console.log(`${missingSeanceRefs.size} séance(s) à extraire`);

  if (missingSeanceRefs.size === 0) {
    console.log('Rien à faire, tout est déjà à jour.');
    return;
  }

  await downloadZip(ZIP_URL, TMP_ZIP_PATH);

  console.log('Ouverture de l\'archive...');
  const zip = new AdmZip(TMP_ZIP_PATH);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.xml'));
  console.log(`${entries.length} fichier(s) XML dans l'archive`);

  let processed = 0;
  let written = 0;

  for (const entry of entries) {
    if (missingSeanceRefs.size === 0) break; // tout a été trouvé, inutile de continuer

    processed += 1;
    if (processed % 200 === 0) {
      console.log(`  ...${processed}/${entries.length} fichiers examinés`);
    }

    const xmlText = entry.getData().toString('utf8');

    // Filtre rapide avant parsing complet
    const seanceRef = quickExtractSeanceRef(xmlText);
    if (!seanceRef || !missingSeanceRefs.has(seanceRef)) continue;

    const compteRendu = parseCompteRendu(xmlText);
    if (compteRendu.sujets.length > 0) {
      matchScrutinsToVotes(compteRendu, votesBySeance.get(seanceRef) || []);

      const outPath = path.join(CR_DIR, seanceRefToFilename(seanceRef));
      fs.writeFileSync(outPath, JSON.stringify(compteRendu, null, 2), 'utf8');
      written += 1;
      missingSeanceRefs.delete(seanceRef);
    }
  }

  console.log(`${written} fichier(s) écrit(s) dans ${path.basename(CR_DIR)}/`);
  if (missingSeanceRefs.size > 0) {
    console.log(
      `${missingSeanceRefs.size} séance(s) introuvable(s) dans l'archive (peut-être pas encore publiée·s) : ` +
        [...missingSeanceRefs].join(', ')
    );
  }

  fs.unlinkSync(TMP_ZIP_PATH);
}

main().catch((err) => {
  console.error('Erreur :', err);
  process.exit(1);
});
