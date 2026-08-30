"""Generate real, self-contained PDF tickets; never render user-supplied HTML."""
from datetime import datetime
from html import escape
from io import BytesIO
from pathlib import Path

import reportlab
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

# Fonts ship with ReportLab, so downloads work without machine-specific fonts.
FONT_DIR = Path(reportlab.__file__).parent / 'fonts'
pdfmetrics.registerFont(TTFont('Ticket', str(FONT_DIR / 'Vera.ttf')))
pdfmetrics.registerFont(TTFont('TicketBold', str(FONT_DIR / 'VeraBd.ttf')))
GREEN = colors.HexColor('#203930')
MUTED = colors.HexColor('#617068')


def ticket_pdf(booking, generated_at):
    output = BytesIO()
    doc = SimpleDocTemplate(output, pagesize=A4, rightMargin=20*mm, leftMargin=20*mm,
        topMargin=18*mm, bottomMargin=18*mm, title='KPi Travels - Bus ticket',
        author='KPi Travels', pageCompression=1)
    body = ParagraphStyle('Body', fontName='Ticket', fontSize=10, leading=15,
                          textColor=GREEN, wordWrap='LTR', splitLongWords=True)
    label = ParagraphStyle('Label', parent=body, fontName='TicketBold', fontSize=9)
    heading = ParagraphStyle('Heading', parent=body, fontName='TicketBold', fontSize=26, leading=32)
    small = ParagraphStyle('Small', parent=body, fontSize=8, leading=12, textColor=MUTED)

    def paragraph(value, style=body):
        # Paragraph supports markup; escaping is mandatory for every supplied value.
        return Paragraph(escape(str(value)).replace('\n', '<br/>'), style)

    def timestamp(value):
        return datetime.fromisoformat(value).strftime('%d %b %Y, %I:%M %p') + ' IST'

    trip = booking['trip']
    fields = [
        ('Booking reference', booking['id']),
        ('Status', booking['status']),
        ('Passenger', f"{booking['passenger_name']} (age {booking['passenger_age']})"),
        ('From', trip['origin']), ('To', trip['destination']),
        ('Bus', f"{trip['bus_name']} / {trip['registration']} / {trip['bus_type']}"),
        ('Departure (IST)', timestamp(trip['departure_at'])),
        ('Arrival (IST)', timestamp(trip['arrival_at'])),
        ('Passengers / seats', '1 passenger / 1 seat'),
        ('Seat', (f"{booking['seat']['seat_label']} / {booking['seat']['deck']} deck"
                  if booking.get('seat') else 'Assigned at boarding')),
        ('Booked fare', f"INR {booking['total_paise']/100:,.2f}"),
    ]
    if trip.get('cancellation_reason'):
        fields.append(('Cancellation reason', trip['cancellation_reason']))
    rows = [[paragraph(key, label), paragraph(value)] for key, value in fields]
    table = Table(rows, colWidths=[43*mm, doc.width-43*mm], hAlign='LEFT')
    table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f4f7f4')),
        ('LINEBELOW', (0, 0), (-1, -1), .4, colors.HexColor('#dbe3dd')),
        ('LEFTPADDING', (0, 0), (-1, -1), 12),
        ('RIGHTPADDING', (0, 0), (-1, -1), 12),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
    ]))
    story = [paragraph('KPi Travels', heading), paragraph('BUS TICKET', small), Spacer(1, 8*mm),
             table, Spacer(1, 7*mm),
             paragraph('No payment collected - assessment demo', label), Spacer(1, 2*mm),
             paragraph('This PDF reflects your booking at download time. After rescheduling or cancellation, '
                       'download a fresh ticket. Check My bookings for the current status.', small),
             Spacer(1, 4*mm), paragraph(f'Downloaded: {timestamp(generated_at)}', small)]

    def footer(canvas, document):
        canvas.saveState()
        canvas.setFont('Ticket', 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(20*mm, 10*mm, 'KPi Travels | All travel times in IST')
        canvas.drawRightString(A4[0]-20*mm, 10*mm, f'Page {document.page}')
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()
