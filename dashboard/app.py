import os
import streamlit as st
import psycopg2
import psycopg2.extras
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from datetime import datetime, date

# -----------------------------------------------------------------------------
# CONFIGURACIÓN DE PÁGINA
# -----------------------------------------------------------------------------
st.set_page_config(
    page_title="En un 2x3 — Plataforma de Control",
    page_icon="🛵",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Estilos CSS personalizados
st.markdown("""
<style>
    .main-header {
        font-size: 2.2rem;
        font-weight: 900;
        background: linear-gradient(90deg, #f59e0b, #ea580c);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        margin-bottom: 0px;
    }
    .sub-header {
        color: #94a3b8;
        font-size: 0.95rem;
        margin-bottom: 20px;
    }
    .metric-card {
        background-color: #0f172a;
        border: 1px solid #1e293b;
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }
    .status-pill {
        padding: 4px 8px;
        border-radius: 9999px;
        font-size: 0.75rem;
        font-weight: bold;
    }
</style>
""", unsafe_allow_html=True)

# -----------------------------------------------------------------------------
# CONEXIÓN A BASE DE DATOS
# -----------------------------------------------------------------------------
DB_HOST = os.environ.get("DB_HOST", "postgres")
DB_USER = os.environ.get("DB_USER", "fonsi_user")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "fonsi_password")
DB_NAME = os.environ.get("DB_NAME", "en_un_2x3")
DB_PORT = os.environ.get("DB_PORT", "5432")

@st.cache_resource
def get_db_connection():
    return psycopg2.connect(
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASSWORD,
        dbname=DB_NAME,
        port=DB_PORT
    )

def run_query(query, params=None, fetch=True):
    try:
        conn = get_db_connection()
        if conn.closed:
            st.cache_resource.clear()
            conn = get_db_connection()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(query, params)
            if fetch:
                res = cur.fetchall()
                return res
            else:
                conn.commit()
                return True
    except Exception as e:
        st.error(f"Error en consulta: {e}")
        return [] if fetch else False

# -----------------------------------------------------------------------------
# SIDEBAR
# -----------------------------------------------------------------------------
with st.sidebar:
    st.image("https://cdn-icons-png.flaticon.com/512/2830/2830312.png", width=70)
    st.markdown("### **EN UN 2X3**")
    st.caption("Fonseca, La Guajira · Plataforma Operativa")
    
    st.divider()
    
    menu = st.radio(
        "Navegación:",
        ["📊 Panel General", "🛵 Pedidos en Vivo", "📖 Libro Mayor (Ledger)", "🧾 Liquidación de Flota", "📢 Comercios & Pauta", "🏍️ Flota de Mensajeros", "📑 Plan del Proyecto (Fases)"],
        index=0
    )
    
    st.divider()
    
    auto_refresh = st.checkbox("🔄 Actualización automática", value=False)
    if st.button("Actualizar Datos Ahora", use_container_width=True):
        st.cache_data.clear()
        st.rerun()
        
    st.caption("🟢 Bot Telegram: **@Fonsi2x3_bot**")

# -----------------------------------------------------------------------------
# HEADER PRINCIPAL
# -----------------------------------------------------------------------------
col_h1, col_h2 = st.columns([3, 1])
with col_h1:
    st.markdown('<p class="main-header">🛵 EN UN 2X3 — CONTROL OPERATIVO</p>', unsafe_allow_html=True)
    st.markdown('<p class="sub-header">Monitoreo en tiempo real de domicilios, mensajería, mototaxis y finanzas</p>', unsafe_allow_html=True)
with col_h2:
    st.info(f"📅 **Fecha:** {date.today().strftime('%d/%m/%Y')}\n\n🟢 **Servidor:** Operativo")

# -----------------------------------------------------------------------------
# VISTA 1: PANEL GENERAL
# -----------------------------------------------------------------------------
if menu == "📊 Panel General":
    # Consultar KPIs
    orders_data = run_query("SELECT count(*) as total, count(*) FILTER (WHERE status = 'DELIVERED') as delivered, coalesce(sum(total), 0) as total_vol, coalesce(sum(subtotal), 0) as subtotal_vol, coalesce(sum(delivery_fee), 0) as fees_vol FROM orders")
    ledger_data = run_query("SELECT coalesce(sum(credit) FILTER (WHERE account = 'ingreso_comision'), 0) as comision_fonsi, coalesce(sum(credit) FILTER (WHERE account = 'ingreso_publicidad'), 0) as ad_revenue FROM ledger")
    couriers_data = run_query("SELECT count(*) as total FROM couriers WHERE is_active = true")
    merchants_data = run_query("SELECT count(*) as total, count(*) FILTER (WHERE sponsored = true) as sponsored FROM merchants")
    
    kpi_orders = orders_data[0] if orders_data else {"total": 0, "delivered": 0, "total_vol": 0, "subtotal_vol": 0, "fees_vol": 0}
    kpi_ledger = ledger_data[0] if ledger_data else {"comision_fonsi": 0, "ad_revenue": 0}
    kpi_couriers = couriers_data[0]["total"] if couriers_data else 0
    kpi_merchants = merchants_data[0] if merchants_data else {"total": 0, "sponsored": 0}
    
    # Tarjetas Métricas
    c1, c2, c3, c4, c5 = st.columns(5)
    with c1:
        st.metric("Total Servicios", f"{kpi_orders['total']}", f"{kpi_orders['delivered']} entregados")
    with c2:
        st.metric("Volumen Ventas", f" COP")
    with c3:
        st.metric("Comisión Fonsi (12%)", f" COP")
    with c4:
        st.metric("Ingreso Publicidad", f" COP")
    with c5:
        st.metric("Flota Activa", f"{kpi_couriers} motos", f"{kpi_merchants['sponsored']} aliados 🌟")

    st.markdown("---")
    
    # Gráficos
    g1, g2 = st.columns([2, 1])
    with g1:
        st.subheader("📈 Distribución de Tipos de Servicio")
        types_res = run_query("SELECT type, count(*) as cantidad, sum(total) as total_cop FROM orders GROUP BY type")
        if types_res:
            df_types = pd.DataFrame(types_res)
            type_map = {'food': '🍔 Domicilios Comida', 'package': '📦 Mandados Libres', 'ride': '🛵 Mototaxis / Viajes'}
            df_types['tipo_label'] = df_types['type'].map(lambda x: type_map.get(x, x))
            fig = px.bar(df_types, x='tipo_label', y='cantidad', color='tipo_label', text='cantidad', title="Servicios por Categoría")
            fig.update_layout(showlegend=False, template="plotly_dark", height=320)
            st.plotly_chart(fig, use_container_width=True)
        else:
            st.info("Sin datos de órdenes suficientes para graficar.")
            
    with g2:
        st.subheader("💳 Métodos de Pago")
        pay_res = run_query("SELECT payment_method, count(*) as count, sum(total) as total FROM orders GROUP BY payment_method")
        if pay_res:
            df_pay = pd.DataFrame(pay_res)
            pay_map = {'cash': '💵 Efectivo', 'transfer': '📱 Transferencia', 'mixed': '🔄 Mixto'}
            df_pay['label'] = df_pay['payment_method'].map(lambda x: pay_map.get(x, x))
            fig_pie = px.pie(df_pay, values='count', names='label', hole=0.4, title="Efectivo vs Digital")
            fig_pie.update_layout(template="plotly_dark", height=320)
            st.plotly_chart(fig_pie, use_container_width=True)
        else:
            st.info("Sin registros de pagos.")

# -----------------------------------------------------------------------------
# VISTA 2: PEDIDOS EN VIVO
# -----------------------------------------------------------------------------
elif menu == "🛵 Pedidos en Vivo":
    st.subheader("📋 Gestión de Pedidos y Despachos en Tiempo Real")
    
    status_filter = st.multiselect(
        "Filtrar por Estado:",
        ["DRAFT", "CONFIRMED", "PREPARING", "ON_THE_WAY", "DELIVERED", "CANCELLED"],
        default=["CONFIRMED", "PREPARING", "ON_THE_WAY", "DELIVERED"]
    )
    
    query = """
        SELECT 
            o.code as "Código",
            o.type as "Tipo",
            coalesce(u.name, 'Cliente') as "Cliente",
            coalesce(m.name, 'Mandado/Viaje') as "Comercio",
            coalesce(c.name || ' (' || c.plate || ')', 'Sin Asignar') as "Mensajero",
            o.subtotal as "Subtotal",
            o.delivery_fee as "Domicilio",
            o.total as "Total COP",
            o.payment_method as "Pago",
            o.payment_status as "Estado Pago",
            o.status as "Estado",
            o.created_at as "Hora"
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
        LEFT JOIN couriers c ON o.courier_id = c.id
        LEFT JOIN merchants m ON o.merchant_id = m.id
        WHERE o.status = ANY(%s)
        ORDER BY o.created_at DESC LIMIT 50
    """
    orders = run_query(query, (status_filter,))
    
    if orders:
        df_orders = pd.DataFrame(orders)
        st.dataframe(df_orders, use_container_width=True, hide_index=True)
        
        # Acciones rápidas sobre órdenes
        st.markdown("### ⚡ Acciones Rápidas")
        ac1, ac2 = st.columns(2)
        with ac1:
            with st.form("form_entregar"):
                st.write("**Marcar Pedido como Entregado (DELIVERED)**")
                order_code = st.text_input("Código de Pedido:", placeholder="FX-1001")
                btn_entregar = st.form_submit_button("✅ Confirmar Entrega y Registrar Contabilidad")
                if btn_entregar and order_code:
                    res = run_query("UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE code = %s RETURNING id, code", (order_code.upper().trim(),), fetch=True)
                    if res:
                        st.success(f"Pedido {order_code} marcado como DELIVERED exitosamente.")
                        st.rerun()
                    else:
                        st.error("No se encontró el código del pedido.")
    else:
        st.info("No hay pedidos con los filtros seleccionados.")

# -----------------------------------------------------------------------------
# VISTA 3: LIBRO MAYOR (LEDGER)
# -----------------------------------------------------------------------------
elif menu == "📖 Libro Mayor (Ledger)":
    st.subheader("📖 Libro Contable de Partida Doble")
    st.caption("Verificación contable estricta: Débito = Crédito")
    
    balance_res = run_query("SELECT sum(debit) as total_debit, sum(credit) as total_credit FROM ledger")
    if balance_res:
        t_deb = balance_res[0]["total_debit"] or 0
        t_cred = balance_res[0]["total_credit"] or 0
        diff = t_deb - t_cred
        
        b1, b2, b3 = st.columns(3)
        b1.metric("Total Débitos (+)", f" COP")
        b2.metric("Total Créditos (-)", f" COP")
        b3.metric("Balance Diferencial", f" COP", "✅ Cuadrado" if diff == 0 else "⚠️ Descuadre")
        
    ledger_entries = run_query("""
        SELECT 
            l.id as "ID",
            l.created_at as "Fecha/Hora",
            coalesce(o.code, '-') as "Orden",
            l.account as "Cuenta Contable",
            l.debit as "Débito (+)",
            l.credit as "Crédito (-)",
            l.memo as "Concepto"
        FROM ledger l
        LEFT JOIN orders o ON l.order_id = o.id
        ORDER BY l.id DESC LIMIT 100
    """)
    
    if ledger_entries:
        st.dataframe(pd.DataFrame(ledger_entries), use_container_width=True, hide_index=True)
    else:
        st.info("Aún no se han registrado asientos contables.")

# -----------------------------------------------------------------------------
# VISTA 4: LIQUIDACIÓN DE FLOTA
# -----------------------------------------------------------------------------
elif menu == "🧾 Liquidación de Flota":
    st.subheader("🧾 Liquidación Diaria de Mensajeros & Cierre de Caja")
    
    today_str = date.today().strftime("%Y-%m-%d")
    st.write(f"Cierre de operaciones para la fecha: **{today_str}**")
    
    settlements = run_query("""
        SELECT 
            s.date as "Fecha",
            c.name as "Mensajero",
            c.plate as "Placa",
            s.cash_collected as "Efectivo Recaudado",
            s.fees_earned as "Tarifas Ganadas (100%)",
            s.owed_to_company as "Debe a Empresa",
            s.net as "Neto a Consignar",
            s.status as "Estado"
        FROM settlements s
        JOIN couriers c ON s.courier_id = c.id
        ORDER BY s.date DESC
    """)
    
    if settlements:
        df_sett = pd.DataFrame(settlements)
        st.dataframe(df_sett, use_container_width=True, hide_index=True)
    else:
        st.info("No hay liquidaciones registradas para el día de hoy. Puedes ejecutarlas desde el bot con /liquidar o esperar el cierre automático de las 10:00 p.m.")

# -----------------------------------------------------------------------------
# VISTA 5: COMERCIOS & PAUTA
# -----------------------------------------------------------------------------
elif menu == "📢 Comercios & Pauta":
    st.subheader("🌟 Comercios Aliados y Publicidad")
    
    tab_m1, tab_m2 = st.tabs(["🏪 Comercios Aliados", "📢 Contratos de Publicidad"])
    
    with tab_m1:
        merchants = run_query("""
            SELECT 
                name as "Nombre",
                specialty as "Especialidad",
                commission_pct as "Comisión %",
                coalesce(ad_plan, 'Sin Pauta') as "Plan Publicidad",
                case when sponsored then '🌟 Aliado Destacado' else 'Orgánico' end as "Tipo"
            FROM merchants
            ORDER BY sponsored DESC, name ASC
        """)
        if merchants:
            st.dataframe(pd.DataFrame(merchants), use_container_width=True, hide_index=True)
            
    with tab_m2:
        contracts = run_query("""
            SELECT 
                merchant_name as "Comercio",
                plan as "Plan",
                price_monthly as "Valor Mensual COP",
                status as "Estado Contrato",
                created_at as "Fecha Inicio"
            FROM ad_contracts
            ORDER BY created_at DESC
        """)
        if contracts:
            st.dataframe(pd.DataFrame(contracts), use_container_width=True, hide_index=True)
        else:
            st.info("No hay contratos de publicidad registrados.")

# -----------------------------------------------------------------------------
# VISTA 6: FLOTA DE MENSAJEROS
# -----------------------------------------------------------------------------
elif menu == "🏍️ Flota de Mensajeros":
    st.subheader("🏍️ Flota de Mensajeros y Conductores en Fonseca")
    
    couriers = run_query("""
        SELECT 
            name as "Nombre",
            wa_phone as "Teléfono",
            vehicle as "Vehículo",
            plate as "Placa",
            rating as "Calificación",
            case when is_active then '🟢 Activo' else '🔴 Inactivo' end as "Estado"
        FROM couriers
        ORDER BY is_active DESC, name ASC
    """)
    if couriers:
        st.dataframe(pd.DataFrame(couriers), use_container_width=True, hide_index=True)
    else:
        st.info("No hay mensajeros registrados.")

# -----------------------------------------------------------------------------
# VISTA 7: PLAN DEL PROYECTO (FASES JSON)
# -----------------------------------------------------------------------------
elif menu == "📑 Plan del Proyecto (Fases)":
    import json
    st.subheader("📑 Hoja de Ruta y Arquitectura: 'En un 2x3' (Fonseca, La Guajira)")
    st.caption("Plan maestro de desarrollo con especificación técnica de las Fases 0 a 5")
    
    json_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "plan_fases_en_un_2x3.json")
    if not os.path.exists(json_path):
        json_path = "/root/en-un-2x3/plan_fases_en_un_2x3.json"
        
    if os.path.exists(json_path):
        with open(json_path, "r", encoding="utf-8") as f:
            plan_data = json.load(f)
            
        st.download_button(
            label="📥 Descargar Plan JSON Completo",
            data=json.dumps(plan_data, indent=2, ensure_ascii=False),
            file_name="plan_fases_en_un_2x3.json",
            mime="application/json"
        )
        
        st.markdown("### 🚀 Resumen de Fases")
        for f in plan_data.get("fases", []):
            with st.expander(f"🔹 Fase {f['fase']}: {f['nombre']} — [{f['estado']} {f['progreso']}%]", expanded=(f['fase'] in [0, 1, 2, 3, 4, 5])):
                st.write(f"**Objetivo:** {f['objetivo']}")
                st.write("**Entregables Principales:**")
                for e in f.get("entregables", []):
                    st.markdown(f"- ✅ {e}")
                if "tools_implementadas" in f:
                    st.write("**Herramientas IA / Backend:**")
                    st.code(", ".join(f["tools_implementadas"]))
                if "criterios_aceptacion" in f:
                    st.write("**Criterios de Aceptación:**")
                    for ca in f["criterios_aceptacion"]:
                        st.markdown(f"- 🎯 {ca}")
                        
        st.markdown("### 🔍 JSON Raw")
        st.json(plan_data)
    else:
        st.warning("El archivo plan_fases_en_un_2x3.json se encuentra en proceso de sincronización.")

