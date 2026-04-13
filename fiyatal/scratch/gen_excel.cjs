const XLSX = require('xlsx');
const path = require('path');

const data = [
	{ "Ürün Adı": "Çimento", "Miktar": "100", "Birim": "Torba", "Marka": "Nuh Çimento" },
	{ "Ürün Adı": "Kum", "Miktar": "10", "Birim": "M3", "Marka": "Ak Kum" },
	{ "Ürün Adı": "Demir", "Miktar": "5", "Birim": "Ton", "Marka": "İskenderun Demir" }
];

const ws = XLSX.utils.json_to_sheet(data);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Talep");

const filePath = path.join(__dirname, 'test_request.xlsx');
XLSX.writeFile(wb, filePath);
console.log('Created:', filePath);
