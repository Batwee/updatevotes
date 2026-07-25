const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');

const ZIP_URL = 'https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip';
const OUTPUT_FILE = path.join(__dirname, 'votes.json');

// Dictionnaire de correspondance des groupes politiques de la 17e législature
const GROUPES_MAP = {
  "PO845401": "RN",        // Rassemblement National
  "PO845407": "EPR",       // Ensemble pour la République (Renaissance)
  "PO845413": "LFI-NFP",   // La France Insoumise - Nouveau Front Populaire
  "PO845419": "SOC",       // Socialistes et apparentés
  "PO845425": "DR",        // Droite Républicaine (LR)
  "PO845439": "EcoS",      // Écologiste et Social
  "PO845454": "Dem",       // Les Démocrates (MoDem)
  "PO845470": "HOR",       // Horizons & Indépendants
  "PO845485": "LIOT",      // Libertés, Indépendants, Outre-mer et Territoires
  "PO845514": "GDR",       // Gauche Démocrate et Républicaine
  "PO872880": "UDR",       // Union des Droites pour la République
  "PO840056": "NI"         // Non-inscrits
};

async function processVotes() {
  try {
    console.log('1. Téléchargement de l archive ZIP...');
    const response = await axios.get(ZIP_URL, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    console.log('2. Lecture et extraction des données...');
    const zip = new AdmZip(Buffer.from(response.data));
    const zipEntries = zip.getEntries();

    const derniersScrutinsParTexte = new Map();

    zipEntries.forEach((entry) => {
      if (!entry.isDirectory && entry.entryName.endsWith('.json')) {
        try {
          const raw = entry.getData().toString('utf8');
          const data = JSON.parse(raw);
          const scrutin = data.scrutin;

          if (!scrutin) return;

          const titre = (scrutin.titre || "Scrutin sans titre").trim();
          const numeroScrutin = Number(scrutin.numero || 0);

          let totalPour = 0;
          let totalContre = 0;
          let totalAbstention = 0;

          const groupesList = [];
          const organes = scrutin.ventilationVotes?.organe?.groupes?.groupe;
          
          if (organes) {
            const groupesArray = Array.isArray(organes) ? organes : [organes];
            
            groupesArray.forEach((g) => {
              const codeOrgane = g.organeRef || "Autre";
              const sigleLisible = GROUPES_MAP[codeOrgane] || codeOrgane;
              
              const voteGroupe = g.vote?.decompteVoix;
              const p = Number(voteGroupe?.pour || 0);
              const c = Number(voteGroupe?.contre || 0);
              const a = Number(voteGroupe?.nonVotants || 0) + Number(voteGroupe?.abstentions || 0);

              totalPour += p;
              totalContre += c;
              totalAbstention += a;

              groupesList.push({
                sigle: sigleLisible,
                pour: p,
                contre: c,
                abstention: a
              });
            });
          }

          // Récupération depuis la synthèse source OU calcul à partir des groupes
          const synSource = scrutin.syntheseVote || {};
          const pourFinal = Number(synSource.nombrePours || synSource.nombrePour || totalPour);
          const contreFinal = Number(synSource.nombreContres || synSource.nombreContre || totalContre);
          const abstentionFinal = Number(synSource.nombreAbstentions || totalAbstention);
          const totalFinal = Number(synSource.totalVotants || (pourFinal + contreFinal + abstentionFinal));

          const voteData = {
            id: scrutin.uid,
            numero: numeroScrutin,
            titre: titre,
            date: scrutin.dateScrutin,
            sort: scrutin.sort?.code || "Non précisé",
            demandeur: scrutin.demandeur?.texte || "Non spécifié",
            syntheseVote: {
              pour: pourFinal,
              contre: contreFinal,
              abstention: abstentionFinal,
              total: totalFinal
            },
            groupes: groupesList
          };

          if (!derniersScrutinsParTexte.has(titre) || numeroScrutin > derniersScrutinsParTexte.get(titre).numero) {
            derniersScrutinsParTexte.set(titre, voteData);
          }
        } catch (e) {
          console.error(`Erreur sur le fichier ${entry.entryName}:`, e.message);
        }
      }
    });

    const cleanVotes = Array.from(derniersScrutinsParTexte.values());
    cleanVotes.sort((a, b) => b.numero - a.numero);

    console.log(`3. Sauvegarde de ${cleanVotes.length} textes/lois uniques...`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(cleanVotes, null, 2), 'utf8');

    console.log('Succès ! Le fichier votes.json a été mis à jour.');
  } catch (err) {
    console.error('Erreur :', err.message);
    process.exit(1);
  }
}

processVotes();
