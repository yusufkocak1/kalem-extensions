# Kalem Eklentileri

[Kalem](https://github.com/yusufkocak1/kalem) için imzalı eklenti kataloğu.
`main` dalına yapılan her push eklentileri paketler, `index.json` dosyasını
imzalar ve GitHub Pages'te yayınlar.

| Eklenti | Ne yapar |
|---|---|
| `graylog` | Graylog 5/6/7'de arama, asistana log araçları |
| `run-configurations` | IntelliJ benzeri çalıştırma ayarları: Tomcat (artifact'leri kendisi bulur), Maven, npm (Vue/React)… |
| `rest-client` | Postman benzeri REST istemcisi; tarayıcıdan cURL/fetch/HAR, Postman koleksiyonu içe aktarma |
| `soap-client` | SoapUI benzeri SOAP istemcisi (WSDL'den örnek zarflar); cURL, zarf ve WSDL dosyası içe aktarma |
| `jenkins` | Jenkins ve içinde QuickPipeline: ortam ağacı, hızlı aksiyonlar, build takibi |
| `log-viewer` | Log dosyalarını büyüdükçe izleme, seviye renkleri, arama |

## Kalem'e eklemek

Kalem 3.38.0 ve sonrasında bu katalog Market'te hazır gelir. Elle eklemek için
Eklentiler › Eklentileri Yönet… › **Kataloglar**:

- **index.json adresi:** `https://yusufkocak1.github.io/kalem-extensions/index.json`
- **Açık anahtar:** `MCowBQYDK2VwAyEAefVQwZSxeRXlfROTZMXbOEQHRId/rGxZKMWl4flq4NI=`

## Geliştirme

Eklentiler gerçek bir Kalem'in içinde test edilir. Bu reponun yanında
`kalem` reposunun derlenmiş bir kopyası olmalı (varsayılan `../kalem`,
başka bir yer için `KALEM_DIR`):

```sh
# ../kalem içinde bir kez
pnpm install && pnpm build && pnpm --dir apps/desktop build

# burada
npm install
npx playwright test                 # hepsi
npx playwright test tests/jenkins   # biri
```

Linux'ta ekransız ortamda `xvfb-run -a npx playwright test`. Tomcat testi
yalnızca `KALEM_TEST_TOMCAT` bir Tomcat klasörünü gösterdiğinde çalışır.

Eklenti API'si (`window.kalem`, izinler, panel kiti) Kalem'in belgelerinde:
`kalem` reposunda `apps/desktop/extension-samples/README.md`. En küçük
örnek oradaki `hello-api`.

### Akış

1. Bir dal açın, `extensions/<ad>/` altında değişikliği yapın,
   `manifest.json` içinde `version` değerini artırın.
2. PR açın: **Test extensions** işi Kalem'in `main`'ini derleyip testleri
   çalıştırır. Yeni bir çekirdek API'si gerekiyorsa önce `kalem`'e girer;
   işi elle çalıştırıp `kalem_ref` ile o dalı seçebilirsiniz.
3. PR birleşince testler `main`'de tekrar çalışır, geçerse **Publish
   catalog** yeni sürümü imzalayıp yayınlar.

## Bir kez: imza anahtarı

Paketleme ve imzalama araçları `kalem` reposunda
(`apps/desktop/scripts/`), CI onları oradan alır.

```sh
node ../kalem/apps/desktop/scripts/extension-registry.mjs keygen keys
```

1. `keys/private.pem` dosyasının **içeriğini** bu reponun
   Settings › Secrets and variables › Actions › **New repository secret**
   bölümüne `KALEM_REGISTRY_KEY` adıyla ekleyin. Dosyayı hiçbir yere commit
   etmeyin (`.gitignore` zaten dışarıda tutar).
2. Settings › Pages › Source: **Deploy from a branch**, `gh-pages` / `(root)`.
3. Anahtar değişirse Kalem'deki gömülü açık anahtar da değişmeli
   (`apps/desktop/src/shared/extension-registry.ts` › `KALEM_REGISTRY`).

## Eklenti eklemek veya güncellemek

- Yeni eklenti: `extensions/<ad>/` klasörü (`manifest.json`, `host.js`…).
- Güncelleme: `manifest.json` içindeki `version` değerini artırın.
  Yayınlanmış bir sürüm asla değiştirilmez; aynı sürümle değişiklik
  yapılırsa yayın durur.
- Kalem kataloğu açılışta ve 6 saatte bir kontrol eder: yeni sürümler
  uygulama güncellenmeden görünür. `engines.kalem` daha yeni bir Kalem
  istiyorsa eklenti "güncelleme gerekiyor" olarak gösterilir.

## Bir sürümü durdurmak

`blocked.json`:

```json
[{ "id": "kalem.jenkins", "versions": "<1.0.1", "reason": "Token'ı loga yazıyordu" }]
```

Push'tan sonraki kontrolde kurulu olduğu her yerde kapatılır.

## Elle yayın (şirket içi sunucu)

```sh
KALEM_REGISTRY_KEY="$(cat keys/private.pem)" \
  node ../kalem/apps/desktop/scripts/extension-registry.mjs build extensions site --name "Kalem Eklentileri" --blocked blocked.json
```

`site/` klasörünü herhangi bir web sunucusuna kopyalayın.
