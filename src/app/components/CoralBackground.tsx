import { motion } from 'motion/react';

export function CoralBackground() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
      <svg
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMax slice"
        className="absolute inset-0 w-full h-full"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Vertical fade — invisible top, fully visible at bottom */}
          <linearGradient id="reef-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="white" stopOpacity="0" />
            <stop offset="42%"  stopColor="white" stopOpacity="0" />
            <stop offset="68%"  stopColor="white" stopOpacity="0.45" />
            <stop offset="100%" stopColor="white" stopOpacity="1" />
          </linearGradient>
          <mask id="reef-mask">
            <rect width="1440" height="900" fill="url(#reef-fade)" />
          </mask>

          {/* Heavy blur for soft background mass glow */}
          <filter id="blob-blur" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="22" />
          </filter>

          {/* Medium glow for structural coral */}
          <filter id="coral-glow" x="-25%" y="-25%" width="150%" height="150%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Tight glow for fine details */}
          <filter id="fine-glow" x="-15%" y="-15%" width="130%" height="130%">
            <feGaussianBlur stdDeviation="1.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g mask="url(#reef-mask)">

          {/* ══════════════════════════════════════════
              LAYER 1 — soft glowing reef mass blobs
              (suggests volume and depth behind corals)
          ══════════════════════════════════════════ */}
          <g opacity="0.13" filter="url(#blob-blur)" fill="#1e96b0">
            {/* Far left mass */}
            <ellipse cx="130"  cy="880" rx="110" ry="32" />
            <ellipse cx="185"  cy="860" rx="70"  ry="24" />
            <ellipse cx="80"   cy="868" rx="60"  ry="18" />
            {/* Left-center */}
            <ellipse cx="400"  cy="882" rx="95"  ry="28" />
            <ellipse cx="360"  cy="866" rx="58"  ry="19" />
            {/* Center */}
            <ellipse cx="670"  cy="879" rx="125" ry="36" />
            <ellipse cx="715"  cy="858" rx="68"  ry="23" />
            <ellipse cx="628"  cy="864" rx="62"  ry="19" />
            {/* Right-center */}
            <ellipse cx="1000" cy="875" rx="105" ry="30" />
            <ellipse cx="1045" cy="856" rx="72"  ry="22" />
            {/* Far right */}
            <ellipse cx="1290" cy="878" rx="115" ry="33" />
            <ellipse cx="1340" cy="860" rx="68"  ry="21" />
          </g>

          {/* ══════════════════════════════════════════
              LAYER 2 — branching coral structures
          ══════════════════════════════════════════ */}
          <g
            fill="none"
            stroke="#5dcfdf"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#coral-glow)"
            opacity="0.09"
          >

            {/* ── LEFT STAGHORN CLUSTER ─────────────── */}
            {/* trunk */}
            <path strokeWidth="3"   d="M155,900 C153,882 158,862 152,840 C147,820 150,802 148,782" />
            {/* primary branches */}
            <path strokeWidth="2"   d="M148,782 C139,762 128,745 120,724 C112,705 108,686 106,666" />
            <path strokeWidth="2"   d="M148,782 C157,761 166,744 170,722 C174,702 173,683 169,663" />
            {/* trunk secondary */}
            <path strokeWidth="1.8" d="M152,840 C143,824 133,812 126,796" />
            <path strokeWidth="1.8" d="M152,840 C160,824 168,812 173,795" />
            {/* left sub-branches */}
            <path strokeWidth="1.2" d="M120,724 C111,708 103,693  97,675 C91,659  89,643  93,625" />
            <path strokeWidth="1.2" d="M120,724 C125,707 130,692 131,674 C132,658 129,642 124,625" />
            {/* right sub-branches */}
            <path strokeWidth="1.2" d="M170,722 C163,706 159,691 157,673 C155,657 157,641 162,624" />
            <path strokeWidth="1.2" d="M170,722 C177,706 183,691 186,673 C189,657 188,641 184,624" />
            {/* terminal tips */}
            <path strokeWidth="0.8" d="M97,675  C91,661  88,647  91,631" />
            <path strokeWidth="0.8" d="M131,674 C127,659 125,645 128,629" />
            <path strokeWidth="0.8" d="M157,673 C154,658 153,644 157,628" />
            <path strokeWidth="0.8" d="M186,673 C183,658 183,644 187,628" />
            <path strokeWidth="0.8" d="M126,796 C119,783 115,770 118,756" />
            <path strokeWidth="0.8" d="M173,795 C177,782 179,769 177,755" />

            {/* ── SEA FAN / GORGONIAN — left-center ──── */}
            <path strokeWidth="1.2" d="M358,900 C357,880 360,860 356,840 C352,820 355,800 351,780 C347,760 350,740 346,720" />
            <path strokeWidth="1"   d="M351,780 C342,768 331,758 323,745 C315,732 310,719 313,705" />
            <path strokeWidth="1"   d="M351,780 C360,768 369,757 375,744 C381,731 384,718 381,704" />
            <path strokeWidth="1"   d="M346,720 C337,710 326,701 319,688 C312,675 310,662 314,648" />
            <path strokeWidth="1"   d="M346,720 C355,710 364,701 370,688 C376,675 378,662 374,648" />
            <path strokeWidth="0.8" d="M356,840 C347,827 336,816 328,802" />
            <path strokeWidth="0.8" d="M356,840 C365,827 374,816 380,802" />
            <path strokeWidth="0.7" d="M313,705 C309,694 308,683 312,671" />
            <path strokeWidth="0.7" d="M381,704 C383,693 383,682 379,670" />
            <path strokeWidth="0.7" d="M314,648 C311,637 313,626 318,614" />
            <path strokeWidth="0.7" d="M374,648 C376,637 376,626 372,614" />

            {/* ── BRAIN CORAL — center-left ─────────── */}
            <g strokeWidth="1.2">
              <ellipse cx="560" cy="862" rx="50" ry="36" />
              <path d="M512,848 C522,841 533,853 544,846 C555,839 566,851 577,844 C588,837 598,849 608,853" />
              <path d="M512,862 C522,855 534,867 545,860 C556,853 567,865 578,858 C589,851 600,860 608,862" />
              <path d="M514,875 C524,868 535,880 546,873 C557,866 568,878 579,871 C590,864 600,872 607,875" />
              <path d="M515,835 C525,828 536,840 547,833 C558,826 569,838 579,831 C589,824 597,834 606,840" />
            </g>

            {/* ── TUBE CORAL CLUSTER — center ──────── */}
            <g strokeWidth="1.5">
              <path d="M690,900 C688,883 691,866 689,850 C687,834 690,818 688,802 C686,787 689,772 687,758" />
              <path d="M703,900 C702,885 705,870 703,855 C701,840 704,825 702,810" />
              <path d="M716,900 C715,884 718,868 716,852 C714,836 717,820 715,804 C713,789 716,774 714,759 C712,744 715,729 713,714" />
              <path d="M729,900 C728,886 731,872 729,858 C727,844 730,830 728,816" />
              <path d="M742,900 C741,887 744,874 742,861 C740,848 743,835 741,822 C739,809 742,796 740,783 C738,770 741,757 739,744" />
              <path d="M755,900 C754,885 757,870 755,856 C753,842 756,828 754,814" />
              {/* rounded caps on tallest tubes */}
              <path strokeWidth="1" d="M685,758 C685,751 689,747 693,751" />
              <path strokeWidth="1" d="M712,714 C712,707 716,703 720,707" />
              <path strokeWidth="1" d="M738,744 C738,737 742,733 746,737" />
            </g>

            {/* ── RIGHT STAGHORN CLUSTER ────────────── */}
            {/* trunk */}
            <path strokeWidth="3"   d="M1045,900 C1043,882 1047,863 1042,841 C1037,821 1040,802 1037,782" />
            {/* primary branches */}
            <path strokeWidth="2"   d="M1037,782 C1027,762 1016,744 1008,722 C1000,702  996,682  994,662" />
            <path strokeWidth="2"   d="M1037,782 C1047,761 1056,743 1061,721 C1066,701 1066,681 1061,661" />
            {/* trunk secondary */}
            <path strokeWidth="1.8" d="M1042,841 C1033,824 1023,811 1016,794" />
            <path strokeWidth="1.8" d="M1042,841 C1051,824 1059,811 1064,794" />
            {/* sub-branches */}
            <path strokeWidth="1.2" d="M1008,722 C999,705 991,689  985,670 C979,653  977,636 981,618" />
            <path strokeWidth="1.2" d="M1008,722 C1014,704 1019,688 1020,669 C1021,652 1018,635 1013,618" />
            <path strokeWidth="1.2" d="M1061,721 C1054,704 1049,688 1047,669 C1045,652 1047,635 1052,618" />
            <path strokeWidth="1.2" d="M1061,721 C1068,704 1074,688 1077,669 C1080,652 1079,635 1075,618" />
            {/* terminal tips */}
            <path strokeWidth="0.8" d="M985,670  C980,654  977,638  981,622" />
            <path strokeWidth="0.8" d="M1013,618 C1011,603 1013,588 1018,574" />
            <path strokeWidth="0.8" d="M1052,618 C1050,602 1052,587 1057,573" />
            <path strokeWidth="0.8" d="M1075,618 C1074,602 1076,587 1081,573" />
            <path strokeWidth="0.8" d="M1016,794 C1010,780 1006,766 1008,751" />
            <path strokeWidth="0.8" d="M1064,794 C1068,780 1070,766 1068,751" />

            {/* ── TALL GORGONIAN FAN — right ────────── */}
            {/* central stem */}
            <path strokeWidth="1.2" d="M1248,900 C1247,878 1250,856 1246,834 C1242,812 1246,790 1242,768 C1238,748 1242,728 1238,708 C1234,688 1238,668 1234,648" />
            {/* left fan branches */}
            <path strokeWidth="0.9" d="M1242,834 C1231,820 1218,808 1207,794 C1196,780 1190,766 1193,750" />
            <path strokeWidth="0.9" d="M1238,768 C1226,756 1214,746 1204,733 C1194,720 1189,706 1193,691" />
            <path strokeWidth="0.9" d="M1234,708 C1223,697 1211,688 1202,675 C1193,662 1189,648 1194,633" />
            <path strokeWidth="0.9" d="M1230,648 C1220,638 1209,629 1201,616 C1193,603 1191,590 1197,576" />
            {/* right fan branches */}
            <path strokeWidth="0.9" d="M1242,834 C1253,820 1265,808 1274,794 C1283,780 1287,766 1284,750" />
            <path strokeWidth="0.9" d="M1238,768 C1249,756 1261,746 1270,733 C1279,720 1282,706 1279,691" />
            <path strokeWidth="0.9" d="M1234,708 C1245,697 1256,688 1264,675 C1272,662 1274,648 1270,633" />
            <path strokeWidth="0.9" d="M1230,648 C1240,638 1251,629 1258,616 C1265,603 1265,590 1260,576" />
            {/* sub-fans */}
            <path strokeWidth="0.6" d="M1193,750 C1189,739 1188,728 1192,716" />
            <path strokeWidth="0.6" d="M1284,750 C1282,739 1281,728 1285,716" />
            <path strokeWidth="0.6" d="M1193,691 C1190,679 1191,668 1196,655" />
            <path strokeWidth="0.6" d="M1279,691 C1277,679 1277,668 1282,655" />

            {/* ── SMALL BRANCHING CLUSTER — far right ─ */}
            <path strokeWidth="2"   d="M1392,900 C1390,884 1394,868 1390,851 C1386,834 1389,818 1387,802" />
            <path strokeWidth="1.5" d="M1387,802 C1379,787 1370,774 1363,759" />
            <path strokeWidth="1.5" d="M1387,802 C1394,787 1401,774 1405,759" />
            <path strokeWidth="1"   d="M1363,759 C1356,745 1351,731 1353,716" />
            <path strokeWidth="1"   d="M1363,759 C1367,744 1369,730 1365,715" />
            <path strokeWidth="1"   d="M1405,759 C1401,744 1399,730 1402,715" />
            <path strokeWidth="1"   d="M1405,759 C1409,744 1412,730 1409,715" />

            {/* ── SCATTERED SMALL COLONIES ──────────── */}
            {/* far left small */}
            <path strokeWidth="1.5" d="M62,900  C61,886 64,872 62,858 C60,844 63,830 61,816" />
            <path strokeWidth="1"   d="M61,816 C55,803 49,792 46,780" />
            <path strokeWidth="1"   d="M61,816 C66,803 72,792 74,780" />
            {/* between fan and brain */}
            <path strokeWidth="1.5" d="M478,898 C477,882 480,866 478,850 C476,834 479,818 477,802" />
            <path strokeWidth="1"   d="M477,802 C471,789 464,778 460,765" />
            <path strokeWidth="1"   d="M477,802 C482,789 488,778 490,765" />
            {/* between brain and tubes */}
            <path strokeWidth="1.5" d="M620,900 C619,885 622,870 620,856 C618,842 621,828 619,814" />
            <path strokeWidth="1"   d="M619,814 C613,800 607,789 604,775" />
            <path strokeWidth="1"   d="M619,814 C625,800 631,789 633,775" />
            {/* between tubes and right staghorn */}
            <path strokeWidth="1.5" d="M840,898 C839,882 842,866 840,850" />
            <path strokeWidth="1"   d="M840,850 C834,836 828,824 824,810" />
            <path strokeWidth="1"   d="M840,850 C846,836 852,824 854,810" />
            {/* between right staghorn and gorgonian */}
            <path strokeWidth="1.5" d="M1148,899 C1147,884 1150,869 1148,855" />
            <path strokeWidth="1"   d="M1148,855 C1142,841 1136,829 1132,815" />
            <path strokeWidth="1"   d="M1148,855 C1154,841 1160,829 1162,815" />
          </g>

          {/* ══════════════════════════════════════════
              LAYER 3 — fine polyp dots at branch tips
          ══════════════════════════════════════════ */}
          <g opacity="0.1" fill="#7ee8fa" filter="url(#fine-glow)">
            {/* left staghorn tips */}
            <circle cx="93"  cy="625" r="2.5" />
            <circle cx="128" cy="629" r="2"   />
            <circle cx="157" cy="628" r="2"   />
            <circle cx="187" cy="628" r="2.5" />
            <circle cx="118" cy="756" r="2"   />
            <circle cx="177" cy="755" r="2"   />
            {/* sea fan tips */}
            <circle cx="312" cy="671" r="1.8" />
            <circle cx="372" cy="670" r="1.8" />
            <circle cx="318" cy="614" r="1.5" />
            <circle cx="372" cy="614" r="1.5" />
            {/* tube coral tips */}
            <circle cx="689" cy="752" r="2.5" />
            <circle cx="714" cy="708" r="2"   />
            <circle cx="740" cy="738" r="2.5" />
            {/* right staghorn tips */}
            <circle cx="981" cy="622" r="2.5" />
            <circle cx="1013" cy="618" r="2"  />
            <circle cx="1052" cy="617" r="2"  />
            <circle cx="1075" cy="617" r="2.5"/>
            <circle cx="1008" cy="751" r="2"  />
            <circle cx="1068" cy="751" r="2"  />
            {/* gorgonian tips */}
            <circle cx="1192" cy="716" r="1.8"/>
            <circle cx="1285" cy="716" r="1.8"/>
            <circle cx="1196" cy="576" r="1.5"/>
            <circle cx="1260" cy="576" r="1.5"/>
          </g>

          {/* ══════════════════════════════════════════
              LAYER 4 — ocean floor baseline
          ══════════════════════════════════════════ */}
          <path
            d="M0,893 C90,888 185,895 290,891 C395,887 490,893 600,889 C710,885 810,892 920,888 C1030,884 1130,891 1240,887 C1350,883 1400,889 1440,886"
            stroke="#3abccc"
            strokeWidth="0.8"
            fill="none"
            opacity="0.12"
          />

        </g>
      </svg>

      {/* Slow breathing animation overlay — very subtle luminance pulse */}
      <motion.div
        animate={{ opacity: [0.04, 0.09, 0.04] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 80% 40% at 50% 100%, rgba(94,207,223,0.35) 0%, transparent 70%)',
        }}
      />
    </div>
  );
}
