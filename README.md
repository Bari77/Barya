# Barya

Salon privé pour Bari et Freya. Le site est en Angular, le serveur en C# (ASP.NET, SignalR, SQL Server). Les messages sont chiffrés avant d’être écrits en base.

## Lancer en local

```bash
podman compose up -d
```

Ouvre http://localhost:8080. Si la page ne répond pas, prends l’adresse de la machine Podman : `podman machine ssh -- "ip -4 addr show eth0"`, puis http://cette-adresse:8080.

Deux comptes, créés au premier démarrage :

- `bari` / `BariLocal!`
- `freya` / `FreyaLocal!`

Pour les changer, modifie `BARI_PASSWORD` et `FREYA_PASSWORD` dans `compose.yaml` avant le premier lancement. SQL Server a besoin d’environ 2 Go de mémoire dans la machine Podman.

## Notifications

Si un message reste non lu 10 secondes après l’envoi, le serveur appelle API Alerts sur le canal de la personne qui n’a pas lu. Un message de Freya part sur le canal `bari`, et un message de Bari sur le canal `freya`. Le titre a la forme `Bari : Message`, le texte est « Vous avez reçu un message ». Chacun règle son canal dans les réglages du salon. Renseigne `API_ALERTS_KEY` dans le service `api`, puis relance le conteneur.

## GIF et clavier

Les GIF sont dans `back/gifs`, servis par le serveur. Pour en ajouter, dépose un fichier `.gif` dans ce dossier et reconstruis l’image. Le clavier utilise `Alphaya.ttf` : capitales A–X et Z. Le Y n’est pas dans la fonte.

## Mise en ligne

Un push sur `master` ou `main` lance `.github/workflows/deploy.yml`.

L’image du serveur part sur `registry.bariserv.net/barya`, avec les étiquettes `latest` et le numéro du commit. Dans le dépôt GitHub, ajoute les secrets `REGISTRY_USERNAME` et `REGISTRY_PASSWORD`. Si le chemin de l’image est différent, ajoute la variable `REGISTRY_IMAGE` avec le nom complet, par exemple `registry.bariserv.net/bari/barya`.

Le site part sur GitHub Pages, à l’adresse `https://bari77.github.io/Barya/`. Dans les réglages du dépôt, la source des Pages doit être GitHub Actions. Ajoute la variable `API_BASE` avec l’adresse HTTPS publique du serveur, par exemple `https://salon.exemple.net`. Sans elle, la page s’ouvre mais le salon ne joint pas l’API. Le serveur doit être en HTTPS. Change `BARYA_KEY` avant un vrai usage : sans la même clé, les anciens messages ne se relisent pas.
