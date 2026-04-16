# Docker Updates - Codex Variant

Tahle slozka obsahuje oddelenou, bezpecnejsi variantu Docker update automatizace pro n8n. Puvodni Claude Code rozpracovani zustava vedle jako reference a neni timhle dotcene.

Aktualni stav hardening test varianty je prubezne vedeny v [README.hardening-test.md](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/README.hardening-test.md:1).

## Co tato varianta dela

1. Jednou denne v `06:30` pres `SSH` zkontroluje whitelistovane sluzby proti remote image stavu.
2. Pokud najde skutecne zastaralou sluzbu, pripravi mail se seznamem a AI komentarem.
3. Odkaz v mailu otevira HTML stranku s checkboxy.
4. Stranka umi jak realny update, tak `dry-run bez zmen` pro bezpecne otestovani flow.
5. Pred spustenim zobrazi best-effort `Aktualne` a `Cil` verzi z Docker image metadata, kdyz je image publikuje.
6. Po potvrzeni se update spousti pres host skript na serveru, ne pres libovolny shell z webu.
7. Po dokonceni prijde vysledek zpet do UI a po realnem updatu i mailem.

## Proc je to bezpecnejsi

- n8n nepousti `docker compose` primo z verejneho webhooku.
- Update muze spustit jen allowlist sluzeb z `allowed-services.txt`.
- `Dry-run` overi vyber, allowlist a pritomnost sluzeb v compose bez `pull/up`.
- `Dry-run` neposila mail, vysledek vraci jen do UI.
- Realny update posle vysledkovy mail jak pro `OK`, tak pro `FAIL`.
- UI i Run endpoint maji tajny path token v URL.
- Workflow neni zavisly na Diun log historii ani na tom, jestli se update zrovna ten den zalogoval.

## Co je v teto slozce

- `plan.md` - lidsky plan a shrnuti.
- `README.hardening-test.md` - aktualni stav, overeni a otevrene body pro oddelenou hardening test variantu.
- `service-map.json` - zdroj pravdy pro image -> service mapu a metadata sluzeb.
- `service-map.hardening-test.json` - overlay config pro oddelenou test variantu vedle live workflowu.
- `generate-workflows.mjs` - generator workflow JSONu.
- `workflow-A-checker.json` - n8n workflow pro denni kontrolu a mail.
- `workflow-B-ui.json` - n8n workflow pro HTML UI.
- `workflow-C-run.json` - n8n workflow pro spusteni updatu.
- `workflow-hardening-test-A-checker.json` - manual-only checker pro hardening test.
- `workflow-hardening-test-B-ui.json` - oddelene UI pro hardening test.
- `workflow-hardening-test-C-run.json` - oddeleny run webhook pro hardening test.
- `allowed-services.txt` - allowlist pro host skript.
- `allowed-services.hardening-test.txt` - stejne data pro test variantu, vygenerovane separatne.
- `docker-update-apply.sh` - host skript, ktery opravdu spousti update.
- `docker-image-version-info.py` - host helper pro current/target verzi a digest bez realneho updatu.

## Co bude potreba v n8n

- `Gmail` credential - uz mas.
- `OpenAI` credential - uz mas.
- `SSH` credential - to pak nastavime spolu.

Doporuceny SSH target:

- host: `home-dataserver.tail9c609e.ts.net`
- user: `jan`
- auth: klic nebo heslo podle toho, co mas v n8n nejpohodlnejsi

Workflowy jsou pripravene tak, aby se do nich pak credential jen prirazil v UI.

## Live vs hardening test

Live homelab workflowy zustavaji:

- `Docker Updates - Checker (Codex)`
- `Docker Updates - UI (Codex)`
- `Docker Updates - Run (Codex)`

Vedle nich je pripravena oddelena test varianta:

- `Docker Updates - Checker (Hardening Test)`
- `Docker Updates - UI (Hardening Test)`
- `Docker Updates - Run (Hardening Test)`

Oddeleni test varianty:

- UI webhook path: `docker-updates-ui-hardening-test-4f6c9d2a7b1e4c3f8a55`
- Run webhook path: `docker-updates-run-hardening-test-8c2e7f1a6d4b4f39a2c1`
- host script path: `/opt/docker/docker-update-apply.phase1.sh`
- checker je manual-only, bez schedulu

Generovani test artefaktu:

```bash
node generate-workflows.mjs --config service-map.hardening-test.json
```

## SSH credential do n8n

Prakticky otestovano:

- z tohoto pocitace funguje SSH na `jan@home-dataserver.tail9c609e.ts.net`
- z `n8n` kontejneru je dostupny SSH port hosta pres:
  - `home-dataserver.tail9c609e.ts.net`
  - `192.168.0.101`
  - `172.17.0.1`

Doporucene nastaveni credentialu v n8n:

- credential name: `SSH Docker Host`
- host: `home-dataserver.tail9c609e.ts.net`
- port: `22`
- user: `jan`
- authentication method: `Private Key` je bezpecnejsi, `Password` je jednodussi pokud uz ho mas po ruce

Fallback, kdyby v n8n zlobil Tailscale DNS resolve:

- host: `192.168.0.101`

## Dulezite chovani

- Canonical URL je `http://home-dataserver.tail9c609e.ts.net:5678`, aby to fungovalo i mimo lokalni sit pres Tailscale.
- HTML stranka pouziva absolutni URL, ne relativni, aby fungovala i v novejsim n8n sandboxu.
- AI review je doporuceni, ne matematicka garance. Krome AI se pouziva i konzervativni baseline podle typu sluzby.

## Nasazeni na host

Host je v tomhle kroku uz pripraveny:

- `/opt/docker/docker-update-apply.sh`
- `/opt/docker/docker-image-version-info.py`
- `/opt/docker/allowed-services.txt`

Na serveru je nastaveno:

```bash
chmod +x /opt/docker/docker-update-apply.sh
```

Dalsi kroky:

1. V n8n vytvor `SSH Docker Host` credential.
2. V n8n importuj workflow JSONy.
3. Doplni se `SSH` credential do node `SSH`.
4. Doplni se `OpenAI` credential do node `OpenAI AI Review`.
5. Doplni se `Gmail` credential do Gmail nodu.
6. Workflowy se publikujou.

## Poznamka k AI review

AI dostava metadata sluzeb, release URL a baseline risk. Proto umi dat rozumne doporuceni typu:

- `Bezpecne`
- `Pozor`
- `Rucni kontrola`

U sluzeb s floating tagy jako `latest` nebo `release` bude AI casto konzervativnejsi, protoze bez explicitniho diffu nelze zarucit presny rozsah zmen.
