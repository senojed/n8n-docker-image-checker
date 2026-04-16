# Docker Updates - Hardening Test

Tento dokument drzi aktualni stav oddelene hardening test varianty vedle live workflowu.

## Aktualni faze

Jsme ve `Phase 1 / functional verification`.

To prakticky znamena:

- test workflowy jsou vygenerovane z repa a nasazene do n8n vedle live sady
- UI webhook, Run webhook i host test script jsou oddelene od live varianty
- probehlo realne overeni mailu, UI, dry-run i ostreho updatu
- test `Run` workflow ted vraci i korektni `400` JSON chyby pro logicky neplatne requesty

## Nasazena test varianta

Workflowy v n8n:

- `Docker Updates - Checker (Hardening Test)`
- `Docker Updates - UI (Hardening Test)`
- `Docker Updates - Run (Hardening Test)`

Oddeleni od live:

- UI webhook path: `docker-updates-ui-hardening-test-4f6c9d2a7b1e4c3f8a55`
- Run webhook path: `docker-updates-run-hardening-test-8c2e7f1a6d4b4f39a2c1`
- host script path: `/opt/docker/docker-update-apply.phase1.sh`
- checker trigger mode: `manual-only`

Repo artefakty:

- [service-map.hardening-test.json](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/service-map.hardening-test.json:1)
- [workflow-hardening-test-A-checker.json](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/workflow-hardening-test-A-checker.json:1)
- [workflow-hardening-test-B-ui.json](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/workflow-hardening-test-B-ui.json:1)
- [workflow-hardening-test-C-run.json](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/workflow-hardening-test-C-run.json:1)

## Overeno

Funkcni testy:

- checker funguje
- mailovy odkaz na UI funguje na production webhooku
- UI stranka se korektne vykresli
- dry-run funguje
- realny update funguje
- auto-include pro `immich-server` a `immich-machine-learning` funguje
- po restartu `n8n` kontejneru zustavaji test webhooky funkcni

Validation testy `Run` webhooku:

- prazdne `services` vraci `400 Bad Request`
- nepovolena sluzba vraci `400 Bad Request`
- spatny `Content-Type` vraci `400 Bad Request`
- rozbity JSON vraci `422 Unprocessable Entity` z parseru n8n
- validni dry-run vraci `200 OK`

Failure-path test:

- byla simulovana kontrolovana chyba pouze v test scriptu `/opt/docker/docker-update-apply.phase1.sh`
- `Run` workflow vratil `ok: false` a smysluplny error payload
- puvodni test script byl po testu obnoven a zkontrolovan `bash -n`

## Co to ted umi

- poslat mail s odkazem na oddelene test UI
- zobrazit pending updaty i u floating tagu, kdy se meni jen digest
- spustit dry-run bez zmen na hostu
- spustit realny update jen pro allowlist sluzeb
- vratit vysledek zpet do UI jako JSON
- poslat vysledkovy mail po realnem updatu
- odmitnout logicky neplatne requesty bez spousteni host skriptu

## Co jeste neni uzavrene

Tohle neni blocker pro hardening test variantu, ale zustava otevrene:

- live `Docker Updates - Checker (Codex)` ma pri aktivaci chybu `object is not iterable`
- to je oddeleny problem live sady, do hardening test varianty jsem kvuli tomu nesahal

## Jak to dal udrzovat

Pri dalsi zmene hardening test varianty aktualizovat:

1. [generate-workflows.mjs](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/generate-workflows.mjs:1)
2. `node generate-workflows.mjs --config service-map.hardening-test.json`
3. tento soubor
4. jen prislusny test workflow v n8n, bez zasahu do live sady

## Posledni dulezite zmeny

- opraven `Build HTML` v test UI workflowu
- doplnena separace test `Run` workflowu proti live scriptu
- opravena validace test `Run` webhooku tak, aby vracela korektni `400` JSON odpovedi
