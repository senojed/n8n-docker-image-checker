# Codex Variant - vysvetleno lidsky

## Co z toho budes mit ty

- V `06:30` prijde checker mail jen tehdy, kdyz je co resit.
- V mailu uvidis, co ma update a jak moc tomu AI veri.
- Kliknes na odkaz, otevres jednoduchou stranku a zaskrtnes, co chces updatovat.
- Po kliknuti se na serveru pusti jen predem povoleny update.
- Dostanes vysledek v UI a po realnem updatu i potvrzovaci mail.

## Jak to tece uvnitr

### 1. Checker

- n8n jednou denne pres SSH projde whitelistovane sluzby.
- U kazde porovna bezici image proti remote image metadata.
- Vybere jen sluzby, ktere jsou opravdu pozadu.
- AI doplni komentar, jestli je update spis bezpecny nebo chce opatrnost.
- Pokud je co resit, prijde mail.

### 2. UI

- Odkaz z mailu otevre HTML stranku z webhooku v n8n.
- Stranka ukaze checkboxy jen pro povolene a skutecne zastarale sluzby.
- U kazde sluzby bude AI verdict, `Aktualne` a `Cil`.
- Kdyz kontrola nejake sluzby selze, ukaze se zvlast jako chyba kontroly.

### 3. Run

- Po submitu jde request na druhy webhook.
- Ten request je omezeny na allowlist sluzeb.
- n8n pres SSH spusti maly host skript.
- Host skript overi, ze opravdu smi updatovat jen povolene sluzby.
- Pak udela `docker compose pull` a `docker compose up -d --no-deps`.

## Proc to neni "jen shell z webu"

Puvodni varianta byla rychla na postaveni, ale prilis duverovala tomu, co prijde do webhooku. Tady je flow vic sevrene:

- povolene jsou jen konkretni service names
- endpoint neni verejny "na hadani", ale ma tajny path token
- skutecny update dela host skript s allowlistem
- AI slouzi jako poradce, ne jako volny vykonavatel prikazu

## Co je jeste potreba dodelat v n8n UI

- nastavit `SSH` credential
- priradit `OpenAI` credential
- priradit `Gmail` credential

To je vse. Zbytek bude pripraveny v tehle slozce.
