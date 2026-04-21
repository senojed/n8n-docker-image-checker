# Host Hardening Snippets

Tahle slozka drzi jen referencni host artefakty pro `2.5 SSH hardening`.
Neni to automaticky installer. Cilem je mit v repu presny vzor, ktery se da
bez improvizace prenest na host.

## Co to resi

- dedikovany SSH ucet `docker-updater` misto bezneho admin shellu
- `authorized_keys` omezeny na forced command
- mensi blast radius pro n8n `Run` workflow

## Doporuceny host setup

1. Zaloz dedikovaneho uzivatele:

```bash
sudo useradd --create-home --shell /usr/sbin/nologin docker-updater
sudo usermod -aG docker docker-updater
```

2. Nahraj na host aktualni skripty a allowlist:

```bash
sudo install -d -o root -g root -m 755 /opt/docker
sudo install -o root -g root -m 755 docker-update-apply.sh /opt/docker/docker-update-apply.sh
sudo install -o root -g root -m 755 docker-image-version-info.py /opt/docker/docker-image-version-info.py
sudo install -o root -g root -m 644 workflows/legacy/allowed-services.txt /opt/docker/allowed-services.txt
```

3. Vytvor `.ssh` adresar a vloz restricted klic podle
[authorized_keys.example](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/host/authorized_keys.example:1):

```bash
sudo install -d -o docker-updater -g docker-updater -m 700 /home/docker-updater/.ssh
sudo install -o docker-updater -g docker-updater -m 600 host/authorized_keys.example /home/docker-updater/.ssh/authorized_keys
```

4. Priprav audit log a rotaci:

```bash
sudo install -d /var/log/docker-updates
sudo touch /var/log/docker-updates/audit.jsonl
sudo chown docker-updater:docker-updater /var/log/docker-updates /var/log/docker-updates/audit.jsonl
sudo chmod 755 /var/log/docker-updates
sudo chmod 664 /var/log/docker-updates/audit.jsonl
sudo cp docker-updates-audit.logrotate /etc/logrotate.d/docker-updates-audit
sudo logrotate -d /etc/logrotate.d/docker-updates-audit
```

## Ocekavane chovani po nasazeni

- `ssh docker-updater@host bash` nema dat shell
- `ssh docker-updater@host 'nextcloud; rm -rf /'` ma spadnout na validaci
- n8n ma mit SSH credential smerovany na `docker-updater`, ne na bezny admin ucet

## Poznamka k forced command

Forced command pouziva `SSH_ORIGINAL_COMMAND`, ale vstup se stejne musi brat jako
neduveryhodny. Bezpecnost nestoji na tom snippet sam o sobe, ale na kombinaci:

- forced command v `authorized_keys`
- allowlist validace v `docker-update-apply.sh`
- dedikovany ucet bez interaktivniho shellu

Volitelny systemd wrapper je v
[docker-updater.service](C:/Users/Honza/Nextcloud/Jan/PROJECTS/docker-image-checker-n8n/host/docker-updater.service:1),
ale neni potreba pro bezny SSH-driven provoz.
