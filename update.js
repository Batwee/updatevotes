const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');

const ZIP_URL = 'https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip';
const OUTPUT_FILE = path.join(__dirname, 'votes.json');

async function processVotes() {
  try {
    console.log('1. Téléchargement de l archive ZIP...');
    const response = await axios.get(ZIP_URL, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    console.log('2. Lecture et extraction détaillée...');
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

          // Extraction du détail par groupe politique pour le graphique
          const groupesList = [];
          const organes = scrutin.ventilationVotes?.organe?.groupes?.groupe;
          
          if (organes) {
            const groupesArray = Array.isArray(organes) ? organes : [organes];
            
            groupesArray.forEach((g) => {
              const sigle = g.organeRef || "Autre";
              const voteGroupe = g.vote?.decompteVoix;
              
              groupesList.push({
                sigle: sigle,
                pour: Number(voteGroupe?.pour || 0),
                contre: Number(voteGroupe?.contre || 0),
                abstention: Number(voteGroupe?.nonVotants || 0) + Number(voteGroupe?.abstentions || 0)
              });
            });
          }

          // Extraction correcte des totaux (noter les 's' dans l'API officielle)
          const synthese = scrutin.syntheseVote || {};
          const voteData = {
            id: scrutin.uid,
            numero: numeroScrutin,
            titre: titre,
            date: scrutin.dateScrutin,
            sort: scrutin.sort?.code || "Non précisé",
            demandeur: scrutin.demandeur?.texte || "Non spécifié",
            syntheseVote: {
              pour: Number(synthese.nombrePours || synthese.nombrePour || 0),
              contre: Number(synthese.nombreContres || synthese.nombreContre || 0),
              abstention: Number(synthese.nombreAbstentions || 0),
              total: Number(synthese.totalVotants || 0)
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
