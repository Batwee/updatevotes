/**
 * update_CR.js
 * ---------------------------------------------------------------------------
 * Télécharge l'archive des comptes rendus intégraux (syceron brut) de
 * l'Assemblée nationale, et n'en extrait que les débats dont la séance
 * (seanceRef) correspond à un scrutin présent dans vote.json (à la racine
 * du repository).
 *
 * Mode incrémental : un fichier JSON est écrit par séance dans le dossier
 * CR/ (ex: CR/RUANR5L17S2025IDS28584.json). Seules les séances qui n'ont
 * pas encore de fichier correspondant sont traitées. Si toutes les séances
 * référencées dans vote.json ont déjà leur fichier, l'archive n'est même
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
const VOTE_JSON_PATH = path.join(ROOT_DIR, 'vote.json');
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
 * pour pouvoir être croisée facilement avec le champ "date" de vote.json.
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

  const orateursBlock = extractTag(block, 'orateurs') || '';
  const nom = extractTag(orateursBlock, 'nom');
  const qualiteRaw = extractTag(orateursBlock, 'qualite');

  const texteRaw = extractTag(block, 'texte');
  const texte = toPlainText(texteRaw);

  // On ignore les interventions vides (ex: didascalies pures sans intérêt)
  if (!texte) return null;

  return {
    orateur: nom ? toPlainText(nom) : null,
    fonction: qualiteRaw ? toPlainText(qualiteRaw) : null,
    role: roledebat || null, // ex: "president" si c'est le/la président(e) de séance
    idActeur: idActeur || null,
    texte,
  };
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
  const paragrapheRegex = /<paragraphe\s+([^>]*)>([\s\S]*?)<\/paragraphe>/g;
  let pMatch;
  while ((pMatch = paragrapheRegex.exec(block)) !== null) {
    const intervention = parseParagraphe(pMatch[1], pMatch[2]);
    if (intervention) interventions.push(intervention);
  }

  // On ignore les points purement procéduraux, sans aucune intervention exploitable.
  if (interventions.length === 0) return null;

  return {
    idSyceron: idSyceron || null,
    valeurPtsOdj: valeurPtsOdj || null,
    titre,
    interventions,
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

  const points = [];
  const pointRegex = /<point\s+([^>]*)>([\s\S]*?)<\/point>/g;
  let match;
  while ((match = pointRegex.exec(xmlText)) !== null) {
    const point = parsePoint(match[1], match[2]);
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

function loadVoteSeanceRefs(votePath) {
  if (!fs.existsSync(votePath)) {
    throw new Error(`Fichier introuvable : ${votePath}`);
  }
  const votes = JSON.parse(fs.readFileSync(votePath, 'utf8'));
  const seanceRefs = new Set();
  for (const vote of votes) {
    if (vote.seanceRef) seanceRefs.add(vote.seanceRef);
  }
  return seanceRefs;
}

async function main() {
  const targetSeanceRefs = loadVoteSeanceRefs(VOTE_JSON_PATH);

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

  console.log(`${targetSeanceRefs.size} séance(s) référencée(s) dans vote.json`);
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
