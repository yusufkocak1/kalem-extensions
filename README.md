# Kalem Eklentileri

[Kalem](https://github.com/yusufkocak1/kalem) için imzalı eklenti kataloğu.
`main` dalına yapılan her push eklentileri paketler, `index.json` dosyasını
imzalar ve GitHub Pages'te yayınlar.

| Eklenti | Ne yapar |
|---|---|
| `graylog` | Graylog 5/6/7'de arama, asistana log araçları |
| `run-configurations` | IntelliJ benzeri çalıştırma ayarları: Tomcat, Maven, npm (Vue/React)… |
| `rest-client` | Postman benzeri REST istemcisi |
| `soap-client` | SoapUI benzeri SOAP istemcisi (WSDL'den örnek zarflar) |
| `jenkins` | Jenkins ve içinde QuickPipeline: ortam ağacı, hızlı aksiyonlar, build takibi |
| `log-viewer` | Log dosyalarını büyüdükçe izleme, seviye renkleri, arama |

## Kalem'e eklemek

Kalem 3.37.0 ve sonrasında bu katalog Market'te hazır gelir. Elle eklemek için
Eklentiler › Eklentileri Yönet… › **Kataloglar**:

- **index.json adresi:** `https://yusufkocak1.github.io/kalem-extensions/index.json`
- **Açık anahtar:** `MCowBQYDK2VwAyEAefVQwZSxeRXlfROTZMXbOEQHRId/rGxZKMWl4flq4NI=`

## Bir kez: kurulum

```sh
npm install --prefix tools
node tools/extension-registry.mjs keygen keys
```

1. `keys/private.pem` dosyasının **içeriğini** GitHub'da
   Settings › Secrets and variables › Actions › **New repository secret**
   olarak `KALEM_REGISTRY_KEY` adıyla ekleyin. Dosyayı hiçbir yere commit
   etmeyin (`.gitignore` zaten dışarıda tutar).
2. Actions › Publish catalog › **Run workflow** ile ilk yayını yapın.
   `gh-pages` dalı oluşur.
3. Settings › Pages › Source: **Deploy from a branch**, `gh-pages` / `(root)`.

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
  node tools/extension-registry.mjs build extensions site --name "Kalem Eklentileri" --blocked blocked.json
```

`site/` klasörünü herhangi bir web sunucusuna kopyalayın.
