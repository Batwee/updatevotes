const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');

const ZIP_URL = 'https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip';
const OUTPUT_FILE = path.join(__dirname, 'votes.json');

// Table de correspondance directe PO... -> Sigle
const MAP_GROUPES = {
  "PO845401": "RN",
  "PO845407": "EPR",
  "PO845413": "LFI-NFP",
  "PO845419": "SOC",
  "PO845425": "DR",
  "PO845439": "EcoS",
  "PO845454": "Dem",
  "PO845470": "HOR",
  "PO845485": "LIOT",
  "PO845514": "GDR",
  "PO872880": "UDR",
  "PO840056": "NI",
  "PO847173": "UDR"
};

// Fonction d'extraction du nombre de voix dans une structure variable
function getVotesCount(obj) {
  if (!obj) return 0;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'string') return parseInt(obj, 10) || 0;
  if (Array.isArray(obj)) return obj.length; // Cas de decompteNominatif (liste de députés)
  if (typeof obj === 'object') {
    if (obj.votant) return Array.isArray(obj.votant) ? obj.votant.length : 1;
    if (obj.nombre) return parseInt(obj.nombre, 10) || 0;
  }
  return 0;
}

async function processVotes() {
  try {
    console.log('1. Téléchargement du fichier ZIP...');
    const response = await axios.get(ZIP_URL, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    console.log('2. Extraction des scrutins...');
    const zip = new AdmZip(Buffer.from(response.data));
    const zipEntries = zip.getEntries();
    const derniersScrutins = new Map();

    zipEntries.forEach((entry) => {
      if (!entry.isDirectory && entry.entryName.endsWith('.json')) {
        try {
          const raw = entry.getData().toString('utf8');
          const data = JSON.parse(raw);
          const s = data.scrutin;

          if (!s) return;

          const titre = (s.titre || "Scrutin sans titre").trim();
          const numero = parseInt(s.numero || 0, 10);

          let calcPour = 0;
          let calcContre = 0;
          let calcAbstention = 0;
          const groupesList = [];

          // Extraction des groupes
          let groupesRaw = s.ventilationVotes?.organe?.groupes?.groupe;
          if (groupesRaw) {
            const arrayGroupes = Array.isArray(groupesRaw) ? groupesRaw : [groupesRaw];

            arrayGroupes.forEach((g) => {
              const codePO = g.organeRef || "Autre";
              const sigle = MAP_GROUPES[codePO] || codePO;

              const voteObj = g.vote || {};
              const decompte = voteObj.decompteVoix || {};
              const nominatif = voteObj.decompteNominatif || {};

              // Récupération des voix par groupe (supporte decompteVoix et decompteNominatif)
              const p = getVotesCount(decompte.pour) || getVotesCount(nominatif.pours);
              const c = getVotesCount(decompte.contre) || getVotesCount(nominatif.contres);
              const a = (getVotesCount(decompte.abstentions) || getVotesCount(nominatif.abstentions)) +
                        (getVotesCount(decompte.nonVotants) || getVotesCount(nominatif.nonVotants));

              calcPour += p;
              calcContre += c;
              calcAbstention += a;

              groupesList.push({ sigle, pour: p, contre: c, abstention: a });
            });
          }

          // Récupération de la synthèse globale (API AN : "nombrePours" / "nombreContres")
          const syn = s.syntheseVote || {};
          const pour = parseInt(syn.nombrePours || syn.nombrePour || 0, 10) || calcPour;
          const contre = parseInt(syn.nombreContres || syn.nombreContre || 0, 10) || calcContre;
          const abstention = parseInt(syn.nombreAbstentions || 0, 10) || calcAbstention;
          const total = parseInt(syn.totalVotants || 0, 10) || (pour + contre + abstention);

          const voteData = {
            id: s.uid,
            numero: numero,
            titre: titre,
            date: s.dateScrutin,
            sort: s.sort?.code || "Non précisé",
            demandeur: s.demandeur?.texte || "Non spécifié",
            syntheseVote: { pour, contre, abstention, total },
            groupes: groupesList
          };

          if (!derniersScrutins.has(titre) || numero > derniersScrutins.get(titre).numero) {
            derniersScrutins.set(titre, voteData);
          }
        } catch (e) {
          // Ignorer les fichiers mal formés
        }
      }
    });

    const cleanVotes = Array.from(derniersScrutins.values()).sort((a, b) => b.numero - a.numero);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(cleanVotes, null, 2), 'utf8');
    console.log(`Succès ! ${cleanVotes.length} scrutins enregistrés dans votes.json`);

  } catch (err) {
    console.error('Erreur :', err.message);
    process.exit(1);
  }
}

processVotes();
