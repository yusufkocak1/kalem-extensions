const TR = {
	"WSDL address": "WSDL adresi",
	Load: "Yükle",
	Reload: "Yeniden yükle",
	Services: "Servisler",
	Recent: "Son kullanılanlar",
	"Load a WSDL": "Bir WSDL yükleyin",
	"Its services and operations show here, each with a sample request made from its schema.":
		"Servisleri ve operasyonları burada görünür; her birinin şemasından üretilmiş örnek isteğiyle.",
	"Pick an operation": "Bir operasyon seçin",
	"Its request opens here, ready to fill in and send.":
		"İsteği burada açılır; doldurup gönderebilirsiniz.",
	Endpoint: "Uç nokta",
	Send: "Gönder",
	Envelope: "Zarf",
	Headers: "Başlıklar",
	Auth: "Yetki",
	Username: "Kullanıcı adı",
	Password: "Parola",
	"Basic authentication, sent with each call.": "Temel kimlik doğrulama; her çağrıyla gönderilir.",
	"Reset to sample": "Örneğe dön",
	Format: "Düzenle",
	Response: "Yanıt",
	"Send the request": "İsteği gönderin",
	"The response shows here, with any SOAP fault.": "Yanıt burada görünür; SOAP fault varsa o da.",
	Sending: "Gönderiliyor…",
	Pretty: "Düzenli",
	Raw: "Ham",
	Copy: "Kopyala",
	Copied: "Kopyalandı",
	Body: "Gövde",
	"Request failed": "İstek başarısız",
	"SOAP fault": "SOAP fault",
	Key: "Anahtar",
	Value: "Değer",
	Remove: "Kaldır",
	Forget: "Unut",
	operations: "operasyon",
	"Sent headers": "Gönderilen başlıklar",
	"Extra headers": "Ek başlıklar",
	Filter: "Filtrele",
	Import: "İçe aktar",
	Imported: "İçe aktarılan",
	"Imported requests": "İçe aktarılan istekler",
	Delete: "Sil",
	"Text to import": "İçe aktarılacak metin",
	"Choose a file": "Bir dosya seçin",
	"Choose file…": "Dosya seç…",
	Open: "Aç",
	Cancel: "Vazgeç",
	"Open the WSDL": "WSDL'i aç",
	"Open in {name}": "{name} içinde aç",
	"Add {n} requests": "{n} isteği ekle",
	"no endpoint": "uç nokta yok",
	"Its services and operations open as if loaded from an address.":
		"Servisleri ve operasyonları, adresten yüklenmiş gibi açılır.",
	"No SOAP call here: the requests found carry no SOAP envelope.":
		"Burada SOAP çağrısı yok: bulunan isteklerde SOAP zarfı yok.",
	"This is not a SOAP call or a WSDL Kalem can read.":
		"Bu, Kalem'in okuyabildiği bir SOAP çağrısı ya da WSDL değil.",
	"Opens in the loaded WSDL's {name} operation.": "Yüklü WSDL'in {name} operasyonunda açılır.",
	"Kept under Imported requests.": "İçe aktarılan istekler altında saklanır.",
	"In the browser's DevTools, Network tab: right-click the call › Copy › Copy as cURL, then paste it here. A WSDL's text or a bare envelope works too.":
		"Tarayıcının geliştirici araçlarında, Ağ (Network) sekmesinde çağrıya sağ tıklayın › Copy › Copy as cURL ve buraya yapıştırın. WSDL metni ya da yalnızca zarf da olur.",
	"cURL (bash or cmd), fetch, PowerShell, a raw HTTP request, HAR, a WSDL or an envelope.":
		"cURL (bash ya da cmd), fetch, PowerShell, ham HTTP isteği, HAR, WSDL ya da zarf.",
	"Keep the browser's own headers (sec-*, user-agent…)":
		"Tarayıcının kendi başlıklarını da al (sec-*, user-agent…)",
};

export function translator(language) {
	const words = language === "tr" ? TR : {};
	return (text) => words[text] ?? text;
}
