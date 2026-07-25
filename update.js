const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');

const ZIP_URL = 'https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip';
const OUTPUT_FILE = path.join(__dirname, 'votes.json');

// Correspondance des codes d'organes vers les sigles politiques (17e législature)
const GROUPES_MAP = {
  "PO845401": "RN",        // Rassemblement National
  "PO845407": "EPR",       // Ensemble pour la République
  "PO845413": "LFI-NFP",   // La France Insoumise
  "PO845419": "SOC",       // Socialistes
  "PO845425": "DR",        // Droite Républicaine
  "PO845439": "EcoS",      // Écologiste et Social
  "PO845454": "Dem",       // Les Démocrates
  "PO845470": "HOR",       // Horizons
  "PO845485": "LIOT",      // LIOT
  "PO845514": "GDR",       // Gauche Démocrate et Républicaine
  "PO872880": "UDR",       // UDR
  "PO840056": "NI"         // Non-inscrits
};

async function processVotes() {
  try {
    console.log('1. Téléchargement du ZIP...');
    const response = await axios.get(ZIP_URL, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    console.log('2. Extraction et analyse...');
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
          const numeroScrutin = parseInt(scrutin.numero || 0, 10);

          let totalPour = 0;
          let totalContre = 0;
          let totalAbstention = 0;

          const groupesList = [];
          
          // Extraction des groupes (gestion tableau vs objet)
          let organes = scrutin.ventilationVotes?.organe?.groupes?.groupe;
          if (organes) {
            if (!Array.isArray(organes)) {
              organes = [organes];
            }

            organes.forEach((g) => {
              const codeOrgane = g.organeRef || "Autre";
              const sigle = GROUPES_MAP[codeOrgane] || codeOrgane;
              
              // Lecture sécurisée du décompte du groupe
              const voteGroupe = g.vote?.decompteVoix || {};
              const p = parseInt(voteGroupe.pour || 0, 10);
              const c = parseInt(voteGroupe.contre || 0, 10);
              const a = parseInt(voteGroupe.nonVotants || 0, 10) + parseInt(voteGroupe.abstentions || 0, 10);

              totalPour += p;
              totalContre += c;
              totalAbstention += a;

              groupesList.push({
                sigle: sigle,
                pour: p,
                contre: c,
                abstention: a
              });
            });
          }

          // Extraction de la synthèse source (plusieurs structures d'API possibles)
          const syn = scrutin.syntheseVote || {};
          let pSource = parseInt(syn.nombrePours || syn.nombrePour || syn.pour || 0, 10);
          let cSource = parseInt(syn.nombreContres || syn.nombreContre || syn.contre || 0, 10);
          let aSource = parseInt(syn.nombreAbstentions || syn.abstention || 0, 10);

          // Si la synthèse d'origine est vide (à 0), on prend la somme calculée depuis les groupes
          const pourFinal = pSource > 0 ? pSource : totalPour;
          const contreFinal = cSource > 0 ? cSource : totalContre;
          const abstentionFinal = aSource > 0 ? aSource : totalAbstention;
          const totalVotants = pourFinal + contreFinal + abstentionFinal;

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
              total: totalVotants
            },
            groupes: groupesList
          };

          if (!derniersScrutinsParTexte.has(titre) || numeroScrutin > derniersScrutinsParTexte.get(titre).numero) {
            derniersScrutinsParTexte.set(titre, voteData);
          }
        } catch (e) {
          // Fichier ignoré si erreur de structure
        }
      }
    });

    const cleanVotes = Array.from(derniersScrutinsParTexte.values());
    cleanVotes.sort((a, b) => b.numero - a.numero);

    console.log(`3. Sauvegarde de ${cleanVotes.length} scrutins...`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(cleanVotes, null, 2), 'utf8');
    console.log('Mis à jour avec succès !');

  } catch (err) {
    console.error('Erreur :', err.message);
    process.exit(1);
  }
}

processVotes();
