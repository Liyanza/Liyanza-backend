# Guide d'intégration — Connexion avec Google (app mobile Flutter)

Ce guide s'adresse au développeur de **`Liyanza-mobile`**
(https://github.com/Liyanza/Liyanza-mobile) et décrit, étape par étape,
comment brancher le bouton "Continuer avec Google" déjà présent dans
`lib/features/authentification/login_screen.dart` sur le nouvel endpoint
backend `POST /auth/google/mobile` (ticket **BACK-507**, voir
`docs/BACKLOG_REORIENTE.md`).

Il ne couvre QUE Google. Le bouton Facebook (`_SocialButton` juste à côté)
reste hors périmètre pour l'instant — même logique d'ensemble, mais avec le
SDK Facebook natif, à traiter dans un ticket séparé le moment venu.

## 1. Ce qui existe déjà côté backend (rien à construire ici)

Le backend expose désormais :

```
POST https://liyanza-backend.onrender.com/auth/google/mobile
Content-Type: application/json

{ "idToken": "<idToken renvoyé par le SDK Google Sign-In natif>" }
```

Réponse `201` (même forme que `POST /auth/login`, que `AuthService` côté
mobile connaît déjà) :

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "user": {
    "id": "...",
    "email": "...",
    "firstName": "...",
    "lastName": "...",
    "role": "COMMUNITY_MANAGER"
  }
}
```

Réponse `401` si le token est invalide/expiré, mal destiné à cette app, si le
compte Google n'a pas d'email vérifié, ou si le compte Liyanza est désactivé.

**Important — ce que ce endpoint fait vs. ce que fait le SDK mobile :** le SDK
`google_sign_in` résout l'identité de l'utilisateur *sur l'appareil* (l'écran
"Choisir un compte" natif Android/iOS) et vous renvoie un `idToken` — un JWT
signé par Google. Le rôle de ce endpoint backend est uniquement de **vérifier
la signature de ce JWT et de créer/rattacher le compte Liyanza correspondant**
puis de renvoyer une session Liyanza normale. Il n'y a pas de redirection
navigateur, pas de `state`, pas de code d'échange à gérer côté app — un seul
appel réseau, comme pour `login()`.

## 2. Pré-requis Google Cloud Console (à faire une seule fois par plateforme)

L'équipe backend a déjà un projet Google Cloud avec un identifiant OAuth de
type **"Application Web"** (`GOOGLE_CLIENT_ID`, utilisé pour le bouton Google
du site web `Liyanza`). Vous devez créer **deux nouveaux identifiants dans ce
MÊME projet** — un par plateforme mobile. Contrairement à un premier réflexe
naturel, **ces deux nouveaux identifiants ne sont jamais transmis au
backend** : leur seul rôle est d'autoriser le sélecteur de compte natif à
s'exécuter pour *votre* application précise (vérifiée par empreinte de
signature sur Android, par bundle ID sur iOS). C'est le client "Application
Web" existant qui sert d'audience au `idToken`, voir §4.2.

### 2.1 Fixer l'`applicationId` Android définitif AVANT de créer l'identifiant

`android/app/build.gradle.kts` déclare actuellement :

```kotlin
applicationId = "com.example.liyanza_mobile"
```

C'est le paquet par défaut généré par `flutter create` — **pas un identifiant
utilisable en production**. Un identifiant OAuth "Android" est lié de façon
définitive à un couple (nom de paquet, empreinte SHA-1) : le changer plus
tard signifie recréer l'identifiant. Avant de continuer, remplacez-le par
votre identifiant définitif (ex. `com.liyanza.mobile`) dans
`build.gradle.kts`, et mettez à jour le `namespace` juste au-dessus s'il
existe.

### 2.2 Récupérer l'empreinte SHA-1 de la clé de signature

En développement (clé de debug générée automatiquement par Flutter) :

```bash
cd android
./gradlew signingReport
```

Cherchez le bloc `Variant: debug` et copiez la ligne `SHA1: ...`.

**Attention** : cette empreinte de debug est différente par machine de
développement. Pour que Google Sign-In fonctionne aussi sur un APK de
production signé (Play Store / distribution interne), il faudra répéter
cette étape avec la clé de **release** une fois qu'elle existera, et créer un
second identifiant "Android" (ou ajouter la nouvelle empreinte, selon
l'organisation choisie côté Google Cloud Console).

### 2.3 Créer l'identifiant OAuth "Android"

Dans [console.cloud.google.com](https://console.cloud.google.com) → menu
**"API et services" → "Identifiants"** → **"Créer des identifiants"** → **"ID
client OAuth"** → type **"Android"** :

- Nom du package : votre `applicationId` définitif (§2.1)
- Empreinte du certificat SHA-1 : celle obtenue en §2.2

Vous n'avez **rien à copier** de cet écran dans le code Flutter — l'existence
de cet identifiant suffit, Google Play Services le retrouve automatiquement
via le nom de paquet + la signature de l'app installée.

### 2.4 Créer l'identifiant OAuth "iOS"

Même écran, type **"iOS"** :

- ID du bundle : celui déclaré dans Xcode pour la cible `Runner` (`PRODUCT_BUNDLE_IDENTIFIER`
  — actuellement une variable de build dans `ios/Runner/Info.plist`, à vérifier/fixer dans
  Xcode : sélectionner la cible `Runner` → onglet **"Signing & Capabilities"** → champ
  **"Bundle Identifier"`).

Cette fois, **notez le "Client ID" iOS généré** (`xxxxx.apps.googleusercontent.com`) : il sert
à la configuration `Info.plist` côté iOS (§3.3).

### 2.5 Récupérer le Client ID "Application Web" existant

Demandez à l'équipe backend la valeur de `GOOGLE_CLIENT_ID` (celle déjà en
place pour BACK-505 — visible aussi dans Google Cloud Console sous
"Identifiants", type "Application Web"). C'est cette valeur, **et uniquement
celle-ci**, qui ira dans `serverClientId` côté Flutter (§4.2) — jamais le
client "Android" ni le client "iOS" créés ci-dessus.

## 3. Configuration du projet Flutter

### 3.1 Ajouter la dépendance

```yaml
# pubspec.yaml
dependencies:
  http: ^1.6.0          # déjà présent
  google_sign_in: ^6.2.1 # à ajouter
```

```bash
flutter pub get
```

> Si `flutter pub add google_sign_in` installe une version majeure supérieure
> (le plugin a changé d'API interne courant 2025 — nouvelle méthode
> `GoogleSignIn.instance.authenticate()` remplaçant l'ancien
> `GoogleSignIn().signIn()`), consultez le README publié sur pub.dev au
> moment de l'installation : la donnée qui nous intéresse (`idToken`) reste
> disponible dans les deux générations d'API, seule la syntaxe d'appel
> change. Le reste de ce guide (bouton, appel backend, stockage du token)
> ne change pas.

### 3.2 Android — aucune configuration supplémentaire

Contrairement à Firebase Auth, `google_sign_in` seul n'exige pas de fichier
`google-services.json` ni de plugin Gradle Google Services. Le fait que
l'identifiant "Android" existe (§2.3) avec le bon nom de paquet + la bonne
empreinte SHA-1 suffit.

### 3.3 iOS — `Info.plist`

`ios/Runner/Info.plist` ne déclare actuellement **aucun** `CFBundleURLTypes`.
Ajoutez-y (remplacez `VOTRE_CLIENT_ID_IOS` par le Client ID iOS noté en
§2.4, et `VOTRE_ID_IOS_INVERSE` par ce même identifiant écrit à l'envers,
partie par partie, tel qu'affiché sous "Informations client iOS" dans la
console Google Cloud — c'est un format fourni tel quel par Google, ne le
recalculez pas à la main) :

```xml
<key>GIDClientID</key>
<string>VOTRE_CLIENT_ID_IOS.apps.googleusercontent.com</string>

<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>VOTRE_ID_IOS_INVERSE</string>
    </array>
  </dict>
</array>
```

## 4. Code Flutter

### 4.1 `lib/services_API/api_constants.dart`

Ajoutez la nouvelle route à côté de `login`/`register` :

```dart
class ApiConstants {
  static const String baseUrl = 'https://liyanza-backend.onrender.com';

  // Auth
  static const String login = '$baseUrl/auth/login';
  static const String register = '$baseUrl/auth/register';
  static const String loginGoogle = '$baseUrl/auth/google/mobile'; // BACK-507

  // ...
}
```

### 4.2 `lib/services_API/auth_service.dart`

`AuthService` ne gère aujourd'hui que `login()` (email/mot de passe) avec un
`token` statique en mémoire. Ajoutez une méthode `loginWithGoogle()` qui suit
exactement le même style (même timeout Render, même `try/catch` qui retourne
`false` plutôt que de laisser remonter l'exception) :

```dart
import 'dart:convert';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:http/http.dart' as http;
import 'api_constants.dart';

class AuthService {
  static String? token;

  // Le `serverClientId` est le GOOGLE_CLIENT_ID "Application Web" existant
  // (voir §2.5 du guide) — PAS le client id Android/iOS créé pour cette
  // app. C'est ce paramètre qui détermine l'audience du idToken renvoyé,
  // donc celui que le backend est capable de vérifier.
  static final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: ['email'],
    serverClientId: 'VOTRE_GOOGLE_CLIENT_ID_WEB.apps.googleusercontent.com',
  );

  Future<bool> login(String email, String password) async {
    // ... inchangé
  }

  Future<bool> loginWithGoogle() async {
    try {
      final googleUser = await _googleSignIn.signIn();
      if (googleUser == null) {
        return false; // l'utilisateur a fermé le sélecteur de compte
      }

      final googleAuth = await googleUser.authentication;
      final idToken = googleAuth.idToken;
      if (idToken == null) return false;

      final response = await http
          .post(
            Uri.parse(ApiConstants.loginGoogle),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'idToken': idToken}),
          )
          .timeout(const Duration(seconds: 45)); // Render gratuit peut prendre du temps

      if (response.statusCode == 200 || response.statusCode == 201) {
        final data = jsonDecode(response.body);
        token = data['accessToken'] ?? data['token'];
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }
}
```

> **Note sur la persistance du token** : `AuthService.token` n'est
> aujourd'hui gardé qu'en mémoire (perdu à chaque redémarrage de l'app),
> aussi bien pour `login()` que pour `loginWithGoogle()`. Ce n'est pas
> spécifique à Google — c'est un choix déjà en place pour la connexion
> classique, hors périmètre de ce ticket. À traiter séparément (ex.
> `flutter_secure_storage`) si vous voulez que la session survive à un
> redémarrage de l'app.

### 4.3 `lib/features/authentification/login_screen.dart`

Le bouton Google existe déjà mais ne fait rien :

```dart
_SocialButton(
  height: h(46),
  radius: s(100),
  icon: Image.asset(
    'assets/icons/google.png',
    width: s(18),
    height: s(18),
    errorBuilder: (context, error, stackTrace) =>
      _GoogleGIcon(size: s(18)),
  ),
  label: 'Continuer avec  Google',
  fontSize: s(16),
  onTap: () {}, // <-- à remplacer
),
```

Remplacez `onTap: () {}` par un appel à la nouvelle méthode, en reprenant le
même style que `_handleLogin()` un peu plus haut dans ce fichier (état de
chargement, navigation vers `/home` en cas de succès) :

```dart
onTap: () async {
  setState(() => _loading = true); // ou l'équivalent déjà utilisé par _handleLogin()
  final success = await _authService.loginWithGoogle();
  setState(() => _loading = false);

  if (success) {
    Navigator.pushReplacementNamed(context, '/home');
  } else {
    // même widget/mécanisme d'erreur que _handleLogin() en cas d'échec
  }
},
```

Adaptez les noms exacts (`_loading`, gestion d'erreur affichée) à ce qui
existe réellement dans votre `_handleLogin()` au moment de l'intégration —
ce guide décrit la forme, pas un copier-coller garanti à 100 % si le fichier
a évolué entre-temps.

## 5. Ce qu'il reste à transmettre à l'équipe backend

Une fois les identifiants Android/iOS créés (§2.3, §2.4), **rien ne doit être
transmis au backend** : `GOOGLE_CLIENT_ID_ANDROID`/`GOOGLE_CLIENT_ID_IOS`
n'existent pas côté serveur, volontairement (voir §2). Le backend n'a besoin
de rien de nouveau pour ce ticket.

## 6. Test de bout en bout

1. Lancer l'app sur un appareil/émulateur avec Google Play Services (émulateur
   Android **avec image "Google APIs" ou "Google Play"**, pas une image AOSP
   nue — sinon le sélecteur de compte Google n'existe pas).
2. Taper "Continuer avec Google", choisir un compte.
3. Vérifier que `AuthService.token` est renseigné et que la navigation vers
   `/home` a bien lieu.
4. En cas d'échec silencieux, le plus fréquent est une empreinte SHA-1 (§2.2)
   qui ne correspond pas à celle réellement utilisée pour signer l'APK testé
   (debug vs release) — Google refuse alors le sélecteur de compte avec une
   erreur `DEVELOPER_ERROR` côté Android, avant même d'atteindre le backend.
