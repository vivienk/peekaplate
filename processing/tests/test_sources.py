import socket
import unittest
from unittest.mock import MagicMock, patch

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.sources import detect_kind, fetch_public, resolve_public_url
from peekaplate_processing.website import extract_website


class SourceTests(unittest.TestCase):

    def addresses(self, address):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address,443))]

    def test_private_reserved_and_mixed_dns_results_are_rejected(self):
        for addresses in [self.addresses("127.0.0.1"),self.addresses("10.0.0.1"),self.addresses("169.254.169.254"),self.addresses("93.184.216.34")+self.addresses("192.168.1.2")]:
            with self.subTest(addresses=addresses):
                with patch("peekaplate_processing.sources.socket.getaddrinfo", return_value=addresses):
                    with self.assertRaises(ExtractionError):resolve_public_url("https://menu.example/menu")

    def test_credentials_unusual_ports_and_non_http_schemes_are_rejected(self):
        for url in ["file:///etc/passwd","ftp://menu.example/menu","https://user:secret@menu.example/menu","https://menu.example:8443/menu","https://menu.example/menu#fragment"]:
            with self.subTest(url=url):
                with self.assertRaises(ExtractionError):resolve_public_url(url)

    def test_connection_uses_validated_ip_but_original_tls_hostname(self):
        connection=MagicMock()
        response=connection.getresponse.return_value
        response.status=200
        response.read.return_value=b"Soup  8.50 CAD"
        response.getheader.side_effect=lambda key,default=None:{"Content-Type":"text/plain","Content-Encoding":"identity"}.get(key,default)
        with patch("peekaplate_processing.sources.socket.getaddrinfo", return_value=self.addresses("93.184.216.34")), patch("peekaplate_processing.sources.HTTPSConnection", return_value=connection) as factory:
            data,media_type,url=fetch_public("https://menu.example/menu?version=2")
            with patch("peekaplate_processing.sources.socket.create_connection") as connector:
                connection._create_connection(("malicious-rebind",443))
        factory.assert_called_once_with("menu.example",443,timeout=30)
        connector.assert_called_once_with(("93.184.216.34",443),timeout=30)
        self.assertEqual(data,b"Soup  8.50 CAD")
        self.assertEqual(connection.request.call_args.args[1],"/menu?version=2")
        connection.close.assert_called_once()

    def test_redirect_to_private_address_is_revalidated_before_connecting(self):
        connection=MagicMock()
        connection.getresponse.return_value.status=302
        connection.getresponse.return_value.getheader.return_value="https://internal.example/menu"
        with patch("peekaplate_processing.sources.socket.getaddrinfo", side_effect=[self.addresses("93.184.216.34"),self.addresses("127.0.0.1")]), patch("peekaplate_processing.sources.HTTPSConnection", return_value=connection) as factory:
            with self.assertRaises(ExtractionError):fetch_public("https://menu.example/menu")
        factory.assert_called_once()

    def test_compressed_and_oversized_responses_fail_without_decoding(self):
        for coding,data in [("gzip",b"compressed"),("identity",b"x"*12_000_001)]:
            with self.subTest(coding=coding):
                connection=MagicMock()
                response=connection.getresponse.return_value
                response.status=200
                response.read.return_value=data
                response.getheader.side_effect=lambda key,default=None:coding if key=="Content-Encoding" else default
                with patch("peekaplate_processing.sources.socket.getaddrinfo", return_value=self.addresses("93.184.216.34")), patch("peekaplate_processing.sources.HTTPSConnection", return_value=connection):
                    with self.assertRaises(ExtractionError):fetch_public("https://menu.example/menu")

    def test_sniffing_uses_signatures_instead_of_filename_assumptions(self):
        self.assertEqual(detect_kind(b"%PDF-1.4"),"pdf")
        self.assertEqual(detect_kind(b"\xff\xd8\xfftest"),"image")
        self.assertEqual(detect_kind(b"<html><body>Menu</body></html>"),"website")
        with self.assertRaises(ExtractionError):detect_kind(b"\x00binary")

    def test_hidden_web_text_and_scripts_do_not_become_menu_facts(self):
        html=b'<html><body><p hidden>Fake Soup 999.00</p><p style="display:none">Other 999.00</p><script>Bad 999.00</script><section id="menu"><p>Soup  8.50 CAD</p></section></body></html>'
        result=extract_website(html,"https://menu.example/")
        self.assertEqual(result["text"],"Soup  8.50 CAD")


if __name__=="__main__":
    unittest.main()
