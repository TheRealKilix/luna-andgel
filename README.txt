LUNA & ANDGEL — V3 COUPLE SPACE
================================

SOLUTION SIMPLE : RELAIS SUR UN PC WINDOWS
------------------------------------------
1) Installe Node.js 22 ou plus recent depuis https://nodejs.org/
2) Dans ce dossier, double-clique sur Lancer-Relais.cmd.
   Le script installe les dependances si necessaire et telecharge cloudflared
   depuis les releases officielles Cloudflare s'il est absent.
3) Garde la fenetre ouverte. Copie l'adresse https://....trycloudflare.com
   affichee par cloudflared.
4) Saisis le code d'appairage affiche dans la fenetre du PC une seule fois
   sur chacun des telephones. Ensuite, chacun choisit son profil (Andgel ou
   Luna); l'application retient l'appairage sur cet appareil.
5) Le PC et la fenetre doivent rester allumes. Si le tunnel redemarre, copie
   sa nouvelle adresse dans les deux applications. Les messages en attente
   restent sur le PC.

Le relais et les messages en attente sont heberges sur le PC. Le tunnel gratuit
Cloudflare fournit une adresse HTTPS/WSS temporaire pour que les telephones
puissent joindre le PC depuis Internet; aucun compte Vercel ou base Redis n'est
necessaire. L'adresse du tunnel et le code d'appairage sont prives; une fois
appaire, l'application memorise le code. L'adresse temporaire change apres un
redemarrage du tunnel. Cloudflare peut voir les adresses IP et les metadonnees;
les contenus des messages restent chiffres par l'application.
Pour ne pas utiliser de fournisseur de tunnel, il faut configurer manuellement
le transfert de port du routeur et un certificat TLS public. Arrete le relais
avec Ctrl+C dans la fenetre.

FONCTIONS ET LIMITES
- Les messages texte, photos, vocaux, réactions, réponses, accusés, dates,
  notes, tâches, albums et jeux sont synchronisés par des enveloppes chiffrées.
- Les photos d'albums sont compressées; l'espace des albums est limité à
  environ 2,5 Mo afin de rester compatible avec le stockage des téléphones.
- La position est facultative, approximative et partagée uniquement après
  autorisation explicite; le suivi s'arrête avec le bouton de désactivation.
- Les vocaux sont enregistrés, prévisualisables, annulables et envoyés après
  confirmation; la durée maximale est de 30 secondes.
- Le relais PC doit rester allume pour la livraison hors ligne. Les messages
  restent en attente sur le PC pendant l'absence de l'autre telephone.

NOTIFICATIONS EN ARRIERE-PLAN (CONFIGURATION REQUISE)
------------------------------------------------------
Les notifications poussees utilisent Firebase Cloud Messaging (FCM); elles
ne fonctionnent pas sans la configuration Firebase:
1) Dans Firebase Console, cree un projet et ajoute une application Android dont
   l'identifiant est `com.lunaandgel.privatechat`.
2) Telecharge `google-services.json` et place-le dans `android\app\`.
3) Dans Firebase > Parametres du projet > Comptes de service, genere une cle
   privee Admin SDK. Place le JSON sur le PC sous
   `%LOCALAPPDATA%\LunaAndgel\firebase-service-account.json`. Ne le partage pas
   et ne le committe jamais.
4) Reconstruis l'APK avec `npm run android:apk`, redemarre `Lancer-Relais.cmd`,
   puis active les notifications dans Options > Notifications sur les deux
   telephones.
Pour que les APK publiees par GitHub incluent FCM, ajoute aussi le secret
`GOOGLE_SERVICES_JSON_BASE64` au depot, avec le contenu Base64 de
`android\app\google-services.json`. Le compte Admin SDK reste uniquement sur
le PC du relais.
Le relais envoie uniquement un texte generique et la categorie de notification;
le contenu des messages ne quitte pas le chiffrement de bout en bout.
Si FCM n'est pas configure, les notifications Android en arriere-plan ne sont
pas disponibles.


The PC method does not use Vercel or Redis. Persistent relay data is kept under
`%LOCALAPPDATA%\LunaAndgel\data`; do not delete that folder if you want to keep
pending messages, scheduled messages, and public keys.


BUILD ANDROID APK
-----------------
Run `npm install` and then `npm run android:apk` on a machine with Java and the
Android SDK installed. The installable debug APK is written to
`Luna-Andgel.apk` in the project root. Install this same file on both phones;
each phone keeps its selected profile and local encryption keys. It is a debug
build for direct installation, not a Play Store release.

IMPORTANT
---------
- Une premiere connexion a deux est necessaire pour echanger les cles ECDH.
- Ne supprime pas `%LOCALAPPDATA%\LunaAndgel\data`: cette donnee contient les
  messages en attente, les cles publiques et les appareils FCM enregistres.
- L'application doit rester ouverte pour le partage de position et le suivi
  des changements; Android peut suspendre le processus en arriere-plan.
- Le tunnel gratuit est temporaire, sans garantie de disponibilite.

DEPOT GITHUB ET MISES A JOUR APK
--------------------------------
Le depot et ses releases doivent etre publics pour que l'application puisse
verifier les mises a jour sans stocker de jeton GitHub dans le telephone.
Le code d'appairage, les cles Firebase et le fichier de signature ne sont pas
publies dans le depot.

Depuis PowerShell, dans le dossier du projet:
  cd "$env:USERPROFILE\Desktop\Projet\luna-andgel"
  winget install --id GitHub.cli -e
  gh auth login
  git init -b main
  git add .
  git commit -m "Initial Luna and Andgel app"
  gh repo create luna-andgel --public --source=. --remote=origin

L'APK deja installee a ete signee avec le keystore Android local. Pour permettre
une mise a jour sans desinstaller l'application ni perdre les donnees locales,
le workflow reutilise ce meme keystore. Dans le meme PowerShell:
  $repo = gh repo view --json nameWithOwner -q .nameWithOwner
  $key = Join-Path $env:USERPROFILE '.android\debug.keystore'
  $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($key))
  gh secret set ANDROID_KEYSTORE_BASE64 --repo $repo --body $base64
  gh secret set ANDROID_KEYSTORE_PASSWORD --repo $repo --body android
  gh secret set ANDROID_KEY_ALIAS --repo $repo --body androiddebugkey
  gh secret set ANDROID_KEY_PASSWORD --repo $repo --body android

Si Firebase est configure, ajoute egalement sa configuration de build:
  $firebase = Join-Path (Get-Location) 'android\app\google-services.json'
  $firebase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($firebase))
  gh secret set GOOGLE_SERVICES_JSON_BASE64 --repo $repo --body $firebase64

Puis pousse le commit (le premier build demarre avec tous les secrets en place):
  git push -u origin main

Ne publie jamais le fichier debug.keystore. Le workflow GitHub Actions cree une
release signee a chaque push sur main. Apres le premier build vert dans l'onglet
Actions, telecharge une fois Luna-Andgel.apk depuis Releases et installe-la
par-dessus l'ancienne application. La signature identique conserve ses donnees.
Garde une copie privee et sauvegardee du keystore; sans cette cle, aucune mise a
jour ne pourra remplacer l'application installee.
Ensuite, l'application verifie les releases et telecharge la nouvelle APK au
demarrage; le bouton "Installer la mise a jour" ouvre l'installateur Android.
Android demandera une confirmation et, la premiere
fois, l'autorisation "Installer des applications inconnues" pour Luna & Andgel;
l'installation ne peut pas etre faite silencieusement.

Pour publier les changements suivants:
  git add .
  git commit -m "Update Luna and Andgel"
  git push

Le workflow attribue un nouveau code de version, construit et signe l'APK, puis
publie la release. N'utilise pas une autre cle de signature; Android refuserait
les mises a jour par-dessus l'application installee.
